import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { FileDiffSummary, HealingLoopResult, HealingRun, HealingRunType } from './healing-types';
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
    if (loop.fileDiffs) {
      await this.writeDiffFiles(loopDir, loop.fileDiffs);
    }
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
    if (run.fileDiffs) {
      await this.writeDiffFiles(this.runDir(run.id), run.fileDiffs);
    }
    await writeFile(join(this.runDir(run.id), 'final-report.md'), this.finalMarkdown(run), 'utf-8');
  }

  async readFinalReport(runId: string): Promise<string | null> {
    try {
      return await readFile(join(this.runDir(runId), 'final-report.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  async readDiffReport(runId: string): Promise<string | null> {
    try {
      return await readFile(join(this.runDir(runId), 'diff.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  private async writeRunJson(run: HealingRun): Promise<void> {
    await mkdir(this.runDir(run.id), { recursive: true });
    await writeFile(join(this.runDir(run.id), 'run.json'), JSON.stringify(run, null, 2), 'utf-8');
  }

  private async writeDiffFiles(dir: string, diffs: FileDiffSummary[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'diff.json'), JSON.stringify(diffs, null, 2), 'utf-8');
    await writeFile(join(dir, 'diff.md'), this.diffMarkdown(diffs), 'utf-8');
  }

  private finalMarkdown(run: HealingRun): string {
    const files = [...new Set(run.loops.flatMap((loop) => loop.changedFiles ?? []))];
    const commands = run.loops.flatMap((loop) => loop.commandsRun ?? []);
    const loopErrors = run.loops
      .filter((loop) => loop.error)
      .map((loop) => `- loop ${loop.loop}: ${redactSecrets(loop.error ?? '', this.redact)}`);
    return [
      `# ${title(run.type)} Run ${run.id}`,
      '',
      `Status: ${run.status}`,
      `Started: ${run.startedAt}`,
      `Finished: ${run.finishedAt ?? '-'}`,
      `Loops: ${run.loops.length}/${run.maxLoops}`,
      `Agent used: ${run.agentUsed ?? '-'}`,
      `Agent fallback path: ${run.agentFallbackPath?.join(' -> ') ?? '-'}`,
      `Provider used: ${run.providerUsed ?? '-'}`,
      `Provider model: ${run.providerModel ?? '-'}`,
      `Provider fallback used: ${run.providerFallbackUsed ?? false}`,
      `Agent warnings: ${run.agentWarnings?.join('; ') ?? '-'}`,
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
      '## Loop Errors',
      '',
      loopErrors.length > 0 ? loopErrors.join('\n') : '- none',
      '',
      '## Summary',
      '',
      run.finalSummary ?? run.error ?? 'No summary.',
      '',
      '## File Changes Summary',
      '',
      this.fileChangesSummary(run.fileDiffs ?? []),
      '',
      '## Per-File Diff',
      '',
      this.perFileDiff(run.fileDiffs ?? []),
      '',
      run.status === 'rolled_back'
        ? 'Rollback status: changes were rolled back after this attempted diff was captured.'
        : '',
      '',
    ].join('\n');
  }

  private diffMarkdown(diffs: FileDiffSummary[]): string {
    return [
      '## File Changes Summary',
      '',
      this.fileChangesSummary(diffs),
      '',
      '## Per-File Diff',
      '',
      this.perFileDiff(diffs),
      '',
    ].join('\n');
  }

  private fileChangesSummary(diffs: FileDiffSummary[]): string {
    if (diffs.length === 0) return 'No file changes were recorded.';

    const header = '| File | Type | + Lines | - Lines | Truncated |';
    const divider = '| --- | ---: | ---: | ---: | ---: |';
    const rows = diffs.map((diff) => [
      '|',
      diff.path,
      '|',
      diff.changeType,
      '|',
      String(diff.additions),
      '|',
      String(diff.deletions),
      '|',
      String(diff.truncated),
      '|',
    ].join(' '));
    return [header, divider, ...rows].join('\n');
  }

  private perFileDiff(diffs: FileDiffSummary[]): string {
    if (diffs.length === 0) return 'No file changes were recorded.';

    return diffs.map((diff) => [
      `### ${diff.path}`,
      '',
      `Change type: ${diff.changeType}`,
      `Additions: ${diff.additions}`,
      `Deletions: ${diff.deletions}`,
      '',
      '````diff',
      diff.diffText,
      '````',
      diff.truncated ? 'Diff truncated. See diff.json for metadata.' : '',
    ].filter((line) => line !== '').join('\n')).join('\n\n');
  }
}

function title(type: HealingRunType): string {
  return type === 'self-healing' ? 'Self-Healing' : 'Self-Upgrade';
}
