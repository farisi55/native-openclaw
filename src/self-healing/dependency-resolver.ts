import { exec } from 'child_process';
import type { CommandRunResult } from './healing-types';
import { redactSecrets } from './log-redactor';
import { SafetyPolicy } from './safety-policy';

export class DependencyResolver {
  private readonly policy: SafetyPolicy;

  constructor(
    private readonly workdir: string,
    private readonly timeoutMs: number,
    private readonly redact = true
  ) {
    this.policy = new SafetyPolicy(workdir);
  }

  async install(packages: string[], saveDev = true): Promise<CommandRunResult[]> {
    const unique = [...new Set(packages)].filter((pkg) => SafetyPolicy.isSafePackageName(pkg));
    const results: CommandRunResult[] = [];

    for (const pkg of unique) {
      const command = `npm install ${pkg} ${saveDev ? '--save-dev' : '--save'}`;
      this.policy.assertAllowedCommand(command);
      results.push(await this.runInstall(command));
    }

    return results;
  }

  private async runInstall(command: string): Promise<CommandRunResult> {
    const started = Date.now();
    return new Promise<CommandRunResult>((resolve) => {
      exec(command, {
        cwd: this.workdir,
        timeout: this.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        resolve({
          command,
          exitCode: typeof error?.code === 'number' ? error.code : error ? null : 0,
          stdout: redactSecrets(stdout, this.redact),
          stderr: redactSecrets(stderr, this.redact),
          durationMs: Date.now() - started,
          timedOut: Boolean(error && 'killed' in error && error.killed),
        });
      });
    });
  }
}
