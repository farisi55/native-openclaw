/**
 * utils/logger.ts
 * Lightweight structured logger — no external dependencies.
 * Output format: JSON in production, human-readable in development/test.
 */

import type { LogLevel } from '../types/global';

// ─── Constants ────────────────────────────────────────────────────────────────

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOURS: Record<LogLevel, string> = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m',  // green
  warn: '\x1b[33m',  // yellow
  error: '\x1b[31m', // red
};

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  level: LogLevel;
  ns: string;
  msg: string;
  [key: string]: unknown;
}

// ─── Logger Class ─────────────────────────────────────────────────────────────

export class Logger {
  private readonly minLevel: number;
  private readonly isProd: boolean;

  constructor(
    private readonly namespace: string,
    level: LogLevel = 'info',
    env: string = process.env['APP_ENV'] ?? 'development'
  ) {
    this.minLevel = LEVEL_RANK[level];
    this.isProd = env === 'production';
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= this.minLevel;
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      ns: this.namespace,
      msg,
      ...meta,
    };

    if (this.isProd) {
      process.stdout.write(JSON.stringify(entry) + '\n');
    } else {
      this.prettyPrint(entry);
    }
  }

  private prettyPrint(entry: LogEntry): void {
    const colour = LEVEL_COLOURS[entry.level];
    const { ts, level, ns, msg, ...rest } = entry;

    const time = `${DIM}${ts.slice(11, 23)}${RESET}`;
    const lvl = `${colour}${BOLD}${level.toUpperCase().padEnd(5)}${RESET}`;
    const namespace = `${DIM}[${ns}]${RESET}`;
    const message = `${msg}`;

    const hasMeta = Object.keys(rest).length > 0;
    const meta = hasMeta
      ? `\n  ${DIM}${JSON.stringify(rest, null, 2).split('\n').join('\n  ')}${RESET}`
      : '';

    const stream = entry.level === 'error' || entry.level === 'warn'
      ? process.stderr
      : process.stdout;

    stream.write(`${time} ${lvl} ${namespace} ${message}${meta}\n`);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }

  /** Return a child logger with a nested namespace. */
  child(subNamespace: string): Logger {
    return new Logger(
      `${this.namespace}:${subNamespace}`,
      Object.keys(LEVEL_RANK)[this.minLevel] as LogLevel,
      this.isProd ? 'production' : 'development'
    );
  }
}

// ─── Root Logger Factory ──────────────────────────────────────────────────────

let _rootLevel: LogLevel = 'info';

export function setRootLogLevel(level: LogLevel): void {
  _rootLevel = level;
}

/**
 * Create a namespaced logger.
 * All loggers inherit the root log level unless overridden.
 */
export function createLogger(namespace: string, level?: LogLevel): Logger {
  return new Logger(
    namespace,
    level ?? _rootLevel,
    process.env['APP_ENV'] ?? 'development'
  );
}
