import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { HealingLoopResult, HealingRun, HealingRunType } from './healing-types';
import { redactSecrets, truncateForReport } from './log-redactor';

export class ReportWriter {
  constructor(
    private readonly runsDir: string,
    private readonly redact = true
  ) {}

  runDir(runId: string): string {
    return join(this.runsDir, runId);
  }

  async writeStart(run: HealingRun, config: Record<string, unknown>): Promise<void> {
    const dir = this.runDir(run.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'input.md'), redactSecrets(run.userInput, this.redact), 'utf-8');
    await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
    await this.writeRunJson(run);
  }

  async writeLoop(runId: string, loop: HealingLoopResult): Promise<void> {
    const loopDir = join(this.runDir(runId), `loop-${loop.loop}`);
    await mkdir(loopDir, { recursive: true });
    if (loop.analysis) await writeFile(join(loopDir, 'analysis.json'), JSON.stringify(loop.analysis, null, 2), 'utf-8');
    if (loop.patchPlan) await writeFile(join(loopDir, 'patch-plan.json'), JSON.stringify(loop.patchPlan, null, 2), 'utf-8');
    if (loop.changedFiles) await writeFile(join(loopDir, 'files-changed.json'), JSON.stringify(loop.changedFiles, null, 2), 'utf-8');
    if (loop.commandsRun) {
      await writeFile(
        join(loopDir, 'command-log.txt'),
        redactSecrets(loop.commandsRun.map((cmd) => [
          `$ ${cmd.command}`,
          cmd.stdout,
          cmd.stderr,
          `exit=${cmd.exitCode} durationMs=${cmd.durationMs} timedOut=${cmd.timedOut}`,
        ].join('\n')).join('\n\n'), this.redact),
        'utf-8'
      );
    }
    if (loop.qaReport) await writeFile(join(loopDir, 'qa-report.json'), JSON.stringify(loop.qaReport, null, 2), 'utf-8');
  }

  async writeFinal(run: HealingRun): Promise<void> {
    await this.writeRunJson(run);
    await writeFile(join(this.runDir(run.id), 'final-report.md'), this.finalMarkdown(run), 'utf-8');
  }

  async readFinalReport(runId: string): Promise<string | null> {
    try {
      return await readFile(join(this.runDir(runId), 'final-report.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  private async writeRunJson(run: HealingRun): Promise<void> {
    await mkdir(this.runDir(run.id), { recursive: true });
    await writeFile(join(this.runDir(run.id), 'run.json'), JSON.stringify(run, null, 2), 'utf-8');
  }

  private finalMarkdown(run: HealingRun): string {
    const files = [...new Set(run.loops.flatMap((loop) => loop.changedFiles ?? []))];
    const commands = run.loops.flatMap((loop) => loop.commandsRun ?? []);
    return [
      `# ${title(run.type)} Run ${run.id}`,
      '',
      `Status: ${run.status}`,
      `Started: ${run.startedAt}`,
      `Finished: ${run.finishedAt ?? '-'}`,
      `Loops: ${run.loops.length}/${run.maxLoops}`,
      '',
      '## User Input',
      '',
      truncateForReport(redactSecrets(run.userInput, this.redact), 2000),
      '',
      '## Files Changed',
      '',
      files.length > 0 ? files.map((file) => `- ${file}`).join('\n') : '- none',
      '',
      '## Commands',
      '',
      commands.length > 0
        ? commands.map((cmd) => `- ${cmd.command}: exit=${cmd.exitCode}, timedOut=${cmd.timedOut}`).join('\n')
        : '- none',
      '',
      '## Summary',
      '',
      run.finalSummary ?? run.error ?? 'No summary.',
      '',
    ].join('\n');
  }
}

function title(type: HealingRunType): string {
  return type === 'self-healing' ? 'Self-Healing' : 'Self-Upgrade';
}
