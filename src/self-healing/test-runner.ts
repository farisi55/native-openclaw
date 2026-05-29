import { exec } from 'child_process';
import type { CommandRunResult } from './healing-types';
import { redactSecrets } from './log-redactor';
import { SafetyPolicy } from './safety-policy';

export class TestRunner {
  private readonly policy: SafetyPolicy;

  constructor(
    private readonly workdir: string,
    private readonly timeoutMs: number,
    private readonly redact = true
  ) {
    this.policy = new SafetyPolicy(workdir);
  }

  async run(command: string): Promise<CommandRunResult> {
    this.policy.assertAllowedCommand(command);
    const started = Date.now();

    return new Promise<CommandRunResult>((resolve) => {
      exec(command, {
        cwd: this.workdir,
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const timedOut = Boolean(error && 'killed' in error && error.killed);
        const exitCode = typeof error?.code === 'number'
          ? error.code
          : error
          ? null
          : 0;

        resolve({
          command,
          exitCode,
          stdout: redactSecrets(stdout, this.redact),
          stderr: redactSecrets(stderr, this.redact),
          durationMs,
          timedOut,
        });
      });
    });
  }

  async runAll(commands: string[]): Promise<CommandRunResult[]> {
    const results: CommandRunResult[] = [];
    for (const command of commands) {
      const result = await this.run(command);
      results.push(result);
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    return results;
  }
}
