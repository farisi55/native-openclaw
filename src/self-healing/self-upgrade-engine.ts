import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { IProvider } from '../types/provider';
import { createLogger } from '../utils/logger';
import { BugAnalyzerAgent } from './bug-analyzer-agent';
import { CodingAgent, type OpenCodeFallbackState } from './coding-agent';
import { DependencyResolver } from './dependency-resolver';
import { DiffGenerator } from './diff-generator';
import { HealingStore } from './healing-store';
import type { FileDiffSummary, HealingLoopResult, HealingRun, QAReport, UpgradeEngineConfig, UpgradeRunInput } from './healing-types';
import { PatchApplier } from './patch-applier';
import { PatchPlanner } from './patch-planner';
import { QAAgent } from './qa-agent';
import { ReportWriter } from './report-writer';
import { filterRestartRelevantChangedFiles, isRestartRequiredForChangedFiles, restartReasonForChangedFiles } from './restart-policy';
import { SnapshotManager } from './snapshot-manager';
import { TestRunner } from './test-runner';
import type { LifecycleManager } from '../runtime/lifecycle-manager';

const logger = createLogger('self-upgrade');

export interface SelfUpgradeEngineDeps {
  provider?: IProvider;
  analyzer?: BugAnalyzerAgent;
  codingAgent?: CodingAgent;
  qaAgent?: QAAgent;
  patchPlanner?: PatchPlanner;
  testRunner?: TestRunner;
  dependencyResolver?: DependencyResolver;
  reportWriter?: ReportWriter;
  store?: HealingStore;
  lifecycleManager?: LifecycleManager;
}

function runId(): string {
  return `upgrade-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
}

export class SelfUpgradeEngine {
  private readonly analyzer: BugAnalyzerAgent;
  private readonly codingAgent: CodingAgent;
  private readonly qaAgent: QAAgent;
  private readonly patchPlanner: PatchPlanner;
  private readonly reportWriter: ReportWriter;
  private readonly store: HealingStore;
  private readonly injectedTestRunner: TestRunner | undefined;
  private readonly injectedDependencyResolver: DependencyResolver | undefined;
  private readonly lifecycleManager: LifecycleManager | undefined;
  private readonly diffGenerator: DiffGenerator;

  constructor(
    private readonly config: UpgradeEngineConfig,
    deps: SelfUpgradeEngineDeps = {}
  ) {
    this.analyzer = deps.analyzer ?? new BugAnalyzerAgent(deps.provider, 'default', config.temperature);
    this.codingAgent = deps.codingAgent ?? new CodingAgent(deps.provider, 'default', config.temperature, config.redactSecrets);
    this.qaAgent = deps.qaAgent ?? new QAAgent();
    this.patchPlanner = deps.patchPlanner ?? new PatchPlanner();
    this.reportWriter = deps.reportWriter ?? new ReportWriter(config.runsDir, config.redactSecrets);
    this.store = deps.store ?? new HealingStore(config.dataDir, 'self-upgrade');
    this.injectedTestRunner = deps.testRunner;
    this.injectedDependencyResolver = deps.dependencyResolver;
    this.lifecycleManager = deps.lifecycleManager;
    this.diffGenerator = new DiffGenerator({ redactSecrets: config.redactSecrets });
  }

  async run(input: UpgradeRunInput): Promise<HealingRun> {
    const workdir = resolve(this.config.workdir);
    const run: HealingRun = {
      id: runId(),
      type: 'self-upgrade',
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
      return this.finish(run, 'aborted', 'Self-upgrade is disabled. Set SELF_UPGRADE_ENABLED=true.');
    }

    const runDir = this.reportWriter.runDir(run.id);
    const snapshot = new SnapshotManager(workdir, join(runDir, 'snapshot'));
    const patchApplier = new PatchApplier(workdir, snapshot);
    const testRunner = this.injectedTestRunner ?? new TestRunner(workdir, this.config.timeoutMs, this.config.redactSecrets);
    const dependencyResolver = this.injectedDependencyResolver ?? new DependencyResolver(workdir, this.config.timeoutMs, this.config.redactSecrets);
    let previousQa: QAReport | undefined;
    const openCodeState: OpenCodeFallbackState = {};

    await this.reportWriter.writeStart(run, {
      maxLoops: this.config.maxLoops,
      testCommands: this.config.testCommands,
      autoApply: this.config.autoApply,
      autoRegister: this.config.autoRegister,
      allowedTargets: this.config.allowedTargets,
    });

    for (let loopNo = 1; loopNo <= this.config.maxLoops; loopNo += 1) {
      run.currentLoop = loopNo;
      const loop: HealingLoopResult = {
        loop: loopNo,
        startedAt: new Date().toISOString(),
        status: 'failed',
      };

      try {
        const analysis = await this.analyzer.analyzeUpgrade({
          userInput: input.userInput,
          ...(input.missingCapability ? { missingCapability: input.missingCapability } : {}),
          ...(previousQa ? { previousQa } : {}),
        });
        if (!analysis.feasible) {
          loop.analysis = analysis;
          loop.error = 'Requested capability was not feasible for autonomous upgrade.';
          loop.finishedAt = new Date().toISOString();
          run.loops.push(loop);
          await this.reportWriter.writeLoop(run.id, loop);
          return this.finish(run, 'aborted', loop.error);
        }

        const patchPlan = this.patchPlanner.planUpgrade(analysis);
        const changedFiles = this.config.autoApply
          ? await this.codingAgent.applyUpgrade({
              userInput: input.userInput,
              analysis,
              patchPlan,
              ...(previousQa ? { previousQa } : {}),
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

        if (!qaReport.passed && qaReport.nextAction === 'install_dependency' && this.config.autoInstall) {
          await snapshot.snapshotFile('package.json').catch(() => undefined);
          await snapshot.snapshotFile('package-lock.json').catch(() => undefined);
          commandsRun.push(...await dependencyResolver.install(qaReport.missingPackages));
          const rerun = await testRunner.runAll(this.config.testCommands);
          commandsRun.push(...rerun);
          qaReport = this.qaAgent.analyze(rerun);
          loop.status = 'dependency_installed';
        } else {
          loop.status = changedFiles.length > 0 ? 'patched' : 'failed';
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
          return this.finish(run, 'passed', this.successSummary(run));
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
      logger.warn('self-upgrade rolled back changes', { runId: run.id, changedFiles: snapshot.changedFiles() });
      return this.finish(run, 'rolled_back', 'Self-upgrade did not pass QA and changes were rolled back.');
    }
    await this.attachRunDiffs(run, snapshot, workdir);
    return this.finish(run, 'failed', 'Self-upgrade did not pass QA.');
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
      autoRegister: this.config.autoRegister,
      autoRestart: this.config.autoRestart,
      workdir: this.config.workdir,
      runsDir: this.config.runsDir,
      testCommands: this.config.testCommands,
      store: this.store.path,
    };
  }

  private async finish(run: HealingRun, status: HealingRun['status'], summary: string): Promise<HealingRun> {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.finalSummary = this.withOpenCodeSummary(run, summary);
    await this.reportWriter.writeFinal(run).catch((err: unknown) => {
      logger.warn('self-upgrade report write failed', { error: err instanceof Error ? err.message : String(err) });
    });
    await this.store.saveRun(run).catch((err: unknown) => {
      logger.warn('self-upgrade store write failed', { error: err instanceof Error ? err.message : String(err) });
    });

    if (status === 'passed' && run.restartRequired && this.config.autoRestart && this.lifecycleManager) {
      this.lifecycleManager.requestRestart({
        reason: run.restartReason ?? 'self-upgrade passed and restart is required for hot registration',
        runId: run.id,
        runType: run.type,
        restartRequired: run.restartRequired,
        changedFiles: this.restartNotificationFiles(run),
        summary: run.finalSummary ?? summary,
      });
      run.restartScheduled = this.lifecycleManager.isRestartScheduled();
      run.finalSummary = this.withOpenCodeSummary(run, this.successSummary(run));
      await this.reportWriter.writeFinal(run).catch((err: unknown) => {
        logger.warn('self-upgrade restart report update failed', { error: err instanceof Error ? err.message : String(err) });
      });
      await this.store.saveRun(run).catch((err: unknown) => {
        logger.warn('self-upgrade restart store update failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    return run;
  }

  private markRestartRequirement(run: HealingRun, changedFiles: string[]): void {
    const restartFiles = filterRestartRelevantChangedFiles(changedFiles);
    const requiresRestart = isRestartRequiredForChangedFiles(restartFiles, 'self-upgrade');
    run.restartRequired = requiresRestart;
    run.restartScheduled = false;
    if (requiresRestart) {
      const reason = restartReasonForChangedFiles(restartFiles, 'self-upgrade');
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

  private successSummary(run: HealingRun): string {
    if (run.restartScheduled) {
      return 'Self-upgrade passed QA. Auto restart scheduled in 1.5s. The new capability will be available after restart.';
    }
    if (run.restartRequired) {
      return this.config.autoRestart
        ? 'Self-upgrade passed QA. Restart is required, but no lifecycle restart was scheduled.'
        : 'Self-upgrade passed QA. Restart is required for the new capability to become available.';
    }
    return 'Self-upgrade passed QA. Restart is not required.';
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
