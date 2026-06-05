import { execFile } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('utils:process-tree');

export interface KillProcessTreeOptions {
  signal?: NodeJS.Signals;
  force?: boolean;
  graceMs?: number;
  platform?: NodeJS.Platform;
  execFileFn?: typeof execFile;
  processKillFn?: typeof process.kill;
}

export interface KillProcessTreeResult {
  pid: number;
  platform: NodeJS.Platform;
  method: 'taskkill' | 'process-group' | 'process';
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isAlreadyExitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /ESRCH|not found|no running instance|not found/i.test(message);
}

export async function killProcessTree(
  pid: number,
  options: KillProcessTreeOptions = {}
): Promise<KillProcessTreeResult> {
  const platform = options.platform ?? process.platform;
  const graceMs = Math.max(0, options.graceMs ?? 5000);
  const force = options.force ?? true;

  if (!Number.isFinite(pid) || pid <= 0) {
    return {
      pid,
      platform,
      method: 'process',
      ok: false,
      error: 'Invalid process id.',
    };
  }

  if (platform === 'win32') {
    const execFileFn = options.execFileFn ?? execFile;
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');

    return new Promise((resolve) => {
      execFileFn('taskkill', args, { windowsHide: true, timeout: Math.max(1000, graceMs) }, (error, stdout, stderr) => {
        const result: KillProcessTreeResult = {
          pid,
          platform,
          method: 'taskkill',
          ok: !error || isAlreadyExitedError(error),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error && !isAlreadyExitedError(error) ? { error: error.message } : {}),
        };
        if (!result.ok) {
          logger.debug('taskkill process tree failed', { result });
        }
        resolve(result);
      });
    });
  }

  const processKillFn = options.processKillFn ?? process.kill;
  const signal = options.signal ?? 'SIGTERM';

  try {
    processKillFn(-pid, signal);
    if (force && graceMs > 0) {
      await sleep(graceMs);
      try {
        processKillFn(-pid, 'SIGKILL');
      } catch (error) {
        if (!isAlreadyExitedError(error)) throw error;
      }
    }
    return {
      pid,
      platform,
      method: 'process-group',
      ok: true,
    };
  } catch (groupError) {
    try {
      processKillFn(pid, signal);
      if (force && graceMs > 0) {
        await sleep(graceMs);
        try {
          processKillFn(pid, 'SIGKILL');
        } catch (error) {
          if (!isAlreadyExitedError(error)) throw error;
        }
      }
      return {
        pid,
        platform,
        method: 'process',
        ok: true,
      };
    } catch (processError) {
      const error = isAlreadyExitedError(processError) ? undefined : String(processError instanceof Error ? processError.message : processError);
      return {
        pid,
        platform,
        method: 'process',
        ok: error === undefined,
        ...(error ? { error } : {}),
      };
    }
  }
}
