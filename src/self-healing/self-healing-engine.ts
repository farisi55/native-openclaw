import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { IProvider } from '../types/provider';
import { GatewayCodingAgent } from '../agent-gateway';
import { createLogger } from '../utils/logger';
import { BugAnalyzerAgent } from './bug-analyzer-agent';
import type { CodingPatchAgent, OpenCodeFallbackState } from './coding-agent';
import { DependencyResolver } from './dependency-resolver';
import { DiffGenerator } from './diff-generator';
import { HealingStore } from './healing-store';
import type { FileDiffSummary, HealingEngineConfig, HealingLoopResult, HealingRun, HealingRunInput, QAReport } from './healing-types';
import { PatchApplier } from './patch-applier';
import { PatchPlanner } from './patch-planner';
import { QAAgent } from './qa-agent';
import { ReportWriter } from './report-writer';
import { filterRestartRelevantChangedFiles, isRestartRequiredForChangedFiles, restartReasonForChangedFiles } from './restart-policy';
import { SnapshotManager } from './snapshot-manager';
import { TestRunner } from './test-runner';
import type { LifecycleManager } from '../runtime/lifecycle-manager';

const logger = createLogger('self-healing');

export interface SelfHealingEngineDeps {
  provider?: IProvider;
  analyzer?: BugAnalyzerAgent;
  codingAgent?: CodingPatchAgent;
  qaAgent?: QAAgent;
  patchPlanner?: PatchPlanner;
  testRunner?: TestRunner;
  dependencyResolver?: DependencyResolver;
  reportWriter?: ReportWriter;
  store?: HealingStore;
  lifecycleManager?: LifecycleManager;
}

function runId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
}

export class SelfHealingEngine {
  private readonly analyzer: BugAnalyzerAgent;
  private readonly codingAgent: CodingPatchAgent;
  private readonly qaAgent: QAAgent;
  private readonly patchPlanner: PatchPlanner;
  private readonly reportWriter: ReportWriter;
  private readonly store: HealingStore;
  private readonly injectedTestRunner: TestRunner | undefined;
  private readonly injectedDependencyResolver: DependencyResolver | undefined;
  private readonly lifecycleManager: LifecycleManager | undefined;
  private readonly diffGenerator: DiffGenerator;

  constructor(
    private readonly config: HealingEngineConfig,
    deps: SelfHealingEngineDeps = {}
  ) {
    this.analyzer = deps.analyzer ?? new BugAnalyzerAgent(deps.provider, 'default', config.temperature);
    this.codingAgent = deps.codingAgent ?? new GatewayCodingAgent({
      ...(deps.provider ? { provider: deps.provider } : {}),
      model: 'default',
      temperature: config.temperature,
      redact: config.redactSecrets,
    });
    this.qaAgent = deps.qaAgent ?? new QAAgent();
    this.patchPlanner = deps.patchPlanner ?? new PatchPlanner();
    this.reportWriter = deps.reportWriter ?? new ReportWriter(config.runsDir, config.redactSecrets);
    this.store = deps.store ?? new HealingStore(config.dataDir, 'self-healing');
    this.injectedTestRunner = deps.testRunner;
    this.injectedDependencyResolver = deps.dependencyResolver;
    this.lifecycleManager = deps.lifecycleManager;
    this.diffGenerator = new DiffGenerator({ redactSecrets: config.redactSecrets });
  }

  async run(input: HealingRunInput): Promise<HealingRun> {
    const workdir = resolve(input.workdir ?? this.config.workdir);
    const run: HealingRun = {
      id: runId('heal'),
      type: 'self-healing',
      status: this.config.enabled ? 'running' : 'aborted',
      userInput: input.userInput,
      startedAt: new Date().toISOString(),
      maxLoops: this.config.maxLoops,
      currentLoop: 0,
      workdir,
      snapshotId: 'snapshot',
      loops: [],
      createdBy: input.source,
    };

    if (!this.config.enabled) {
      return this.finish(run, 'aborted', 'Self-healing is disabled. Set SELF_HEALING_ENABLED=true.');
    }

    const runDir = this.reportWriter.runDir(run.id);
    const snapshot = new SnapshotManager(workdir, join(runDir, 'snapshot'));
    const patchApplier = new PatchApplier(workdir, snapshot);
    const testRunner = this.createTestRunner(workdir);
    const dependencyResolver = this.createDependencyResolver(workdir);
    let previousQa: QAReport | undefined;
    const openCodeState: OpenCodeFallbackState = {};

    await this.reportWriter.writeStart(run, {
      maxLoops: this.config.maxLoops,
      testCommands: this.config.testCommands,
      autoApply: this.config.autoApply,
      autoInstall: this.config.autoInstall,
      autoRollback: this.config.autoRollback,
    });

    for (let loopNo = 1; loopNo <= this.config.maxLoops; loopNo += 1) {
      run.currentLoop = loopNo;
      const loop: HealingLoopResult = {
        loop: loopNo,
        startedAt: new Date().toISOString(),
        status: 'failed',
      };

      try {
        const analysis = await this.analyzer.analyze({
          userInput: input.userInput,
          ...(input.errorLog ? { errorLog: input.errorLog } : {}),
          ...(input.targetFiles ? { targetFiles: input.targetFiles } : {}),
          ...(previousQa ? { previousQa } : {}),
        });
        const patchPlan = this.patchPlanner.planBugFix(analysis);
        const changedFiles = this.config.autoApply
          ? await this.codingAgent.applyBugFix({
              userInput: input.userInput,
              analysis,
              patchPlan,
              ...(previousQa ? { previousQa } : {}),
              ...(input.errorLog ? { errorLog: input.errorLog } : {}),
              patchApplier,
              runId: run.id,
              loop: loopNo,
              openCodeState,
            })
          : [];
        this.syncOpenCodeState(run, openCodeState);

        const commands = await testRunner.runAll(this.config.testCommands);
        let qaReport = this.qaAgent.analyze(commands);
        const commandsRun = [...commands];
        let dependencyInstalled = false;

        if (!qaReport.passed && qaReport.nextAction === 'install_dependency' && this.config.autoInstall) {
          await snapshot.snapshotFile('package.json').catch(() => undefined);
          await snapshot.snapshotFile('package-lock.json').catch(() => undefined);
          const installResults = await dependencyResolver.install(qaReport.missingPackages);
          commandsRun.push(...installResults);
          dependencyInstalled = true;
          const rerun = await testRunner.runAll(this.config.testCommands);
          commandsRun.push(...rerun);
          qaReport = this.qaAgent.analyze(rerun);
          loop.status = 'dependency_installed';
        } else {
          if (!qaReport.passed && qaReport.nextAction === 'install_dependency' && !this.config.autoInstall) {
            loop.error = `Dependency install skipped because autoInstall=false. Missing packages: ${
              qaReport.missingPackages.length > 0 ? qaReport.missingPackages.join(', ') : 'unknown'
            }.`;
          }
          loop.status = changedFiles.length > 0 ? 'patched' : 'failed';
        }
        if (qaReport.passed && this.config.autoApply && changedFiles.length === 0 && !dependencyInstalled) {
          qaReport = {
            passed: false,
            summary: 'No connector produced detectable file changes.',
            missingPackages: [],
            errors: ['NO_DETECTABLE_CHANGES'],
            nextAction: 'retry_fix',
            rawLogExcerpt: 'Build/tests passed, but no patch was produced for the requested repair.',
          };
          loop.status = 'failed';
          loop.error = qaReport.summary;
        }

        loop.analysis = analysis;
        loop.patchPlan = patchPlan;
        loop.changedFiles = changedFiles;
        loop.commandsRun = commandsRun;
        loop.qaReport = qaReport;
        loop.missingPackages = qaReport.missingPackages;
        loop.fileDiffs = await this.generateDiffs(snapshot, changedFiles, workdir);
        loop.finishedAt = new Date().toISOString();
        run.loops.push(loop);
        await this.reportWriter.writeLoop(run.id, loop);

        if (qaReport.passed) {
          await this.attachRunDiffs(run, snapshot, workdir);
          this.markRestartRequirement(run, snapshot.changedFiles());
          return this.finish(run, 'passed', this.successSummary(run, loopNo));
        }

        previousQa = qaReport;
      } catch (err) {
        this.syncOpenCodeState(run, openCodeState);
        loop.error = err instanceof Error ? err.message : String(err);
        loop.finishedAt = new Date().toISOString();
        run.loops.push(loop);
        await this.reportWriter.writeLoop(run.id, loop);
        previousQa = {
          passed: false,
          summary: loop.error,
          missingPackages: [],
          errors: [loop.error],
          nextAction: 'retry_fix',
          rawLogExcerpt: loop.error,
        };
      }
    }

    if (this.config.autoRollback) {
      await this.attachRunDiffs(run, snapshot, workdir);
      await snapshot.rollback();
      logger.warn('self-healing rolled back changes', { runId: run.id, changedFiles: snapshot.changedFiles() });
      return this.finish(run, 'rolled_back', 'Self-healing did not pass QA and changes were rolled back.');
    }

    await this.attachRunDiffs(run, snapshot, workdir);
    return this.finish(run, 'failed', 'Self-healing did not pass QA.');
  }

  async listRuns(): Promise<HealingRun[]> {
    return this.store.list();
  }

  async getRun(id: string): Promise<HealingRun | null> {
    return this.store.get(id);
  }

  async getReport(id: string): Promise<string | null> {
    const run = await this.store.get(id);
    return run ? this.reportWriter.readFinalReport(run.id) : null;
  }

  async getDiffReport(id: string): Promise<string | null> {
    const run = await this.store.get(id);
    return run ? this.reportWriter.readDiffReport(run.id) : null;
  }

  getStatus(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      maxLoops: this.config.maxLoops,
      autoApply: this.config.autoApply,
      autoInstall: this.config.autoInstall,
      autoRollback: this.config.autoRollback,
      autoRestart: this.config.autoRestart,
      workdir: this.config.workdir,
      runsDir: this.config.runsDir,
      testCommands: this.config.testCommands,
      store: this.store.path,
    };
  }

  private createTestRunner(workdir: string): TestRunner {
    if (this.injectedTestRunner) return this.injectedTestRunner;
    return new TestRunner(workdir, this.config.timeoutMs, this.config.redactSecrets);
  }

  private createDependencyResolver(workdir: string): DependencyResolver {
    if (this.injectedDependencyResolver) return this.injectedDependencyResolver;
    return new DependencyResolver(workdir, this.config.timeoutMs, this.config.redactSecrets);
  }

  private async finish(run: HealingRun, status: HealingRun['status'], summary: string): Promise<HealingRun> {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.finalSummary = this.withOpenCodeSummary(run, summary);
    await this.reportWriter.writeFinal(run).catch((err: unknown) => {
      logger.warn('self-healing report write failed', { error: err instanceof Error ? err.message : String(err) });
    });
    await this.store.saveRun(run).catch((err: unknown) => {
      logger.warn('self-healing store write failed', { error: err instanceof Error ? err.message : String(err) });
    });

    if (status === 'passed' && run.restartRequired && this.config.autoRestart && this.lifecycleManager) {
      this.lifecycleManager.requestRestart({
        reason: run.restartReason ?? 'self-healing passed and restart is required',
        runId: run.id,
        runType: run.type,
        restartRequired: run.restartRequired,
        changedFiles: this.restartNotificationFiles(run),
        summary: run.finalSummary ?? summary,
      });
      run.restartScheduled = this.lifecycleManager.isRestartScheduled();
      run.finalSummary = this.withOpenCodeSummary(run, this.successSummary(run, run.currentLoop));
      await this.reportWriter.writeFinal(run).catch((err: unknown) => {
        logger.warn('self-healing restart report update failed', { error: err instanceof Error ? err.message : String(err) });
      });
      await this.store.saveRun(run).catch((err: unknown) => {
        logger.warn('self-healing restart store update failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    return run;
  }

  private markRestartRequirement(run: HealingRun, changedFiles: string[]): void {
    const restartFiles = filterRestartRelevantChangedFiles(changedFiles);
    const requiresRestart = isRestartRequiredForChangedFiles(restartFiles, 'self-healing');
    run.restartRequired = requiresRestart;
    run.restartScheduled = false;
    if (requiresRestart) {
      const reason = restartReasonForChangedFiles(restartFiles, 'self-healing');
      if (reason) run.restartReason = reason;
    }
  }

  private syncOpenCodeState(run: HealingRun, state: OpenCodeFallbackState): void {
    if (state.attempted !== undefined) run.openCodeAttempted = state.attempted;
    if (state.attempts !== undefined) run.openCodeAttempts = state.attempts;
    if (state.fallbackUsed !== undefined) run.openCodeFallbackUsed = state.fallbackUsed;
    if (state.unavailable !== undefined) run.opencodeUnavailable = state.unavailable;
    if (state.unavailableReason) run.opencodeUnavailableReason = state.unavailableReason;
    if (state.lastError) run.opencodeError = state.lastError;
    if (state.lastErrorType) run.opencodeErrorType = state.lastErrorType;
    if (state.lastSuggestion) run.opencodeSuggestion = state.lastSuggestion;
    if (state.gatewayAgentId) run.agentUsed = state.gatewayAgentId;
    if (state.gatewayFallbackPath) run.agentFallbackPath = [...state.gatewayFallbackPath];
    if (state.providerId) run.providerUsed = state.providerId;
    if (state.providerModel) run.providerModel = state.providerModel;
    if (state.providerFallbackUsed !== undefined) run.providerFallbackUsed = state.providerFallbackUsed;
    if (state.gatewayWarnings) run.agentWarnings = [...state.gatewayWarnings];
  }

  private withOpenCodeSummary(run: HealingRun, summary: string): string {
    if (run.opencodeErrorType === 'timed-out-with-changes') {
      return `${summary} OpenCode timed out after making changes. QA passed, so changes were accepted.`;
    }
    if (run.opencodeErrorType === 'permission-warning') {
      return `${summary} OpenCode reported permission-rejected but produced meaningful changes. QA passed, so changes were accepted.`;
    }
    if (run.openCodeFallbackUsed && run.opencodeErrorType) {
      const suggestion = run.opencodeSuggestion ? ` Suggestion: ${run.opencodeSuggestion}` : '';
      return `${summary} OpenCode failed: ${run.opencodeErrorType}.${suggestion} Internal CodingAgent fallback was used.`;
    }
    if (run.openCodeFallbackUsed && run.opencodeUnavailableReason) {
      return `${summary} OpenCode was attempted but unavailable (${run.opencodeUnavailableReason}), so internal CodingAgent fallback was used.`;
    }
    if (run.openCodeFallbackUsed) {
      return `${summary} OpenCode was attempted and internal CodingAgent fallback was used.`;
    }
    return summary;
  }

  private async attachRunDiffs(run: HealingRun, snapshot: SnapshotManager, workdir: string): Promise<void> {
    run.fileDiffs = await this.generateDiffs(snapshot, snapshot.changedFiles(), workdir);
  }

  private async generateDiffs(
    snapshot: SnapshotManager,
    changedFiles: string[],
    workdir: string
  ): Promise<FileDiffSummary[]> {
    const inputs = await Promise.all([...new Set(changedFiles)].sort().map(async (file) => ({
      path: file,
      beforeContent: await snapshot.getOriginalContent(file),
      afterContent: await readCurrentFile(workdir, file),
    })));
    return this.diffGenerator.generateDiffs(inputs);
  }

  private successSummary(run: HealingRun, loops: number): string {
    const base = `Self-healing passed after ${loops} loop(s).`;
    if (run.restartScheduled) {
      return `${base} Auto restart scheduled in 1.5s.`;
    }
    if (run.restartRequired) {
      return this.config.autoRestart ? `${base} Restart is required, but no lifecycle restart was scheduled.` : `${base} Restart is required.`;
    }
    return base;
  }

  private restartNotificationFiles(run: HealingRun): string[] {
    const fromDiffs = run.fileDiffs?.map((diff) => diff.path) ?? [];
    const fromLoops = run.loops.flatMap((loop) => loop.changedFiles ?? []);
    return filterRestartRelevantChangedFiles([...fromDiffs, ...fromLoops]);
  }
}

async function readCurrentFile(workdir: string, filePath: string): Promise<string | null> {
  try {
    return await readFile(join(workdir, filePath), 'utf-8');
  } catch {
    return null;
  }
}
