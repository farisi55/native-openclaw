import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';

const logger = createLogger('runtime:lifecycle');

export interface RestartRequest {
  reason: string;
  runId?: string;
  runType?: string;
  delayMs?: number;
  exitCode?: number;
}

interface LifecycleManagerOptions {
  mode?: 'exit' | 'disabled';
  delayMs?: number;
  exitCode?: number;
  manualEnabled?: boolean;
  isTestRuntime?: boolean;
  exitFn?: (code?: number) => never | void;
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
}

export function isTestRuntime(): boolean {
  return process.env['NODE_ENV'] === 'test' ||
    process.env['VITEST'] !== undefined ||
    process.env['JEST_WORKER_ID'] !== undefined ||
    process.env['NODE_TEST_CONTEXT'] !== undefined;
}

export class LifecycleManager {
  private restartScheduled = false;

  constructor(private readonly options: LifecycleManagerOptions = {}) {}

  requestRestart(input: RestartRequest): void {
    if (this.restartScheduled) {
      logger.debug('restart already scheduled; ignoring duplicate request', {
        runId: input.runId,
        runType: input.runType,
      });
      return;
    }

    const mode = this.options.mode ?? restartMode();
    const testRuntime = this.options.isTestRuntime ?? isTestRuntime();

    if (mode === 'disabled' || testRuntime) {
      logger.info('restart request ignored', {
        reason: input.reason,
        runId: input.runId,
        runType: input.runType,
        mode,
        testRuntime,
      });
      return;
    }

    const delayMs = input.delayMs ?? this.options.delayMs ?? getEnvInt('AUTONOMOUS_RESTART_DELAY_MS', 1_500);
    const exitCode = input.exitCode ?? this.options.exitCode ?? getEnvInt('AUTONOMOUS_RESTART_EXIT_CODE', 42);
    this.restartScheduled = true;
    const logMessage = input.runType === 'self-healing'
      ? 'Self-healing passed. Auto restart scheduled.'
      : input.runType === 'self-upgrade'
        ? 'Self-upgrade passed. Auto restart scheduled.'
        : 'Restart scheduled.';

    logger.warn(logMessage, {
      reason: input.reason,
      runId: input.runId,
      runType: input.runType,
      delayMs,
      exitCode,
    });

    const schedule = this.options.setTimeoutFn ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const exit = this.options.exitFn ?? ((code?: number) => process.exit(code));
    schedule(() => {
      process.exitCode = exitCode;
      exit(exitCode);
    }, delayMs);
  }

  requestManualRestart(reason = 'manual restart requested'): boolean {
    if (!this.isManualRestartEnabled()) return false;
    this.requestRestart({ reason });
    return this.isRestartScheduled();
  }

  isRestartScheduled(): boolean {
    return this.restartScheduled;
  }

  isManualRestartEnabled(): boolean {
    return this.options.manualEnabled ?? getEnvBool('AUTONOMOUS_RESTART_MANUAL_ENABLED', false);
  }

  getStatus(): Record<string, unknown> {
    return {
      scheduled: this.restartScheduled,
      mode: this.options.mode ?? restartMode(),
      exitCode: this.options.exitCode ?? getEnvInt('AUTONOMOUS_RESTART_EXIT_CODE', 42),
      delayMs: this.options.delayMs ?? getEnvInt('AUTONOMOUS_RESTART_DELAY_MS', 1_500),
      manualEnabled: this.isManualRestartEnabled(),
      testRuntime: this.options.isTestRuntime ?? isTestRuntime(),
    };
  }
}

function restartMode(): 'exit' | 'disabled' {
  const raw = (getOptionalEnv('AUTONOMOUS_RESTART_MODE', 'exit') ?? 'exit').toLowerCase();
  return raw === 'disabled' ? 'disabled' : 'exit';
}
