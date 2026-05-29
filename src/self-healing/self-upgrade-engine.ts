import { join, resolve } from 'path';
import type { IProvider } from '../types/provider';
import { createLogger } from '../utils/logger';
import { BugAnalyzerAgent } from './bug-analyzer-agent';
import { CodingAgent } from './coding-agent';
import { DependencyResolver } from './dependency-resolver';
import { HealingStore } from './healing-store';
import type { HealingLoopResult, HealingRun, QAReport, UpgradeEngineConfig, UpgradeRunInput } from './healing-types';
import { PatchApplier } from './patch-applier';
import { PatchPlanner } from './patch-planner';
import { QAAgent } from './qa-agent';
import { ReportWriter } from './report-writer';
import { SnapshotManager } from './snapshot-manager';
import { TestRunner } from './test-runner';

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
            })
          : [];

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
        loop.finishedAt = new Date().toISOString();
        run.loops.push(loop);
        await this.reportWriter.writeLoop(run.id, loop);

        if (qaReport.passed) {
          return this.finish(run, 'passed', 'Self-upgrade passed QA. Restart may be required for hot registration.');
        }

        previousQa = qaReport;
      } catch (err) {
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
      await snapshot.rollback();
      logger.warn('self-upgrade rolled back changes', { runId: run.id, changedFiles: snapshot.changedFiles() });
      return this.finish(run, 'rolled_back', 'Self-upgrade did not pass QA and changes were rolled back.');
    }
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

  getStatus(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      maxLoops: this.config.maxLoops,
      autoApply: this.config.autoApply,
      autoInstall: this.config.autoInstall,
      autoRollback: this.config.autoRollback,
      autoRegister: this.config.autoRegister,
      workdir: this.config.workdir,
      runsDir: this.config.runsDir,
      testCommands: this.config.testCommands,
      store: this.store.path,
    };
  }

  private async finish(run: HealingRun, status: HealingRun['status'], summary: string): Promise<HealingRun> {
    run.status = status;
    run.finishedAt = new Date().toISOString();
    run.finalSummary = summary;
    await this.reportWriter.writeFinal(run).catch((err: unknown) => {
      logger.warn('self-upgrade report write failed', { error: err instanceof Error ? err.message : String(err) });
    });
    await this.store.saveRun(run).catch((err: unknown) => {
      logger.warn('self-upgrade store write failed', { error: err instanceof Error ? err.message : String(err) });
    });
    return run;
  }
}
