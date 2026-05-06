/**
 * tools/system.ts
 * System tool — returns local system info without spawning subprocesses.
 *
 * All operations use Node.js built-ins (no child_process.exec) to keep
 * the CLI responsive and cross-platform.
 *
 * Supported queries:
 *   time / what time / current time
 *   date / what date / today's date
 *   uptime / system uptime
 *   platform / os / operating system
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('tool:system');

export interface SystemResult {
  ok: boolean;
  content: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ─── Query handlers ───────────────────────────────────────────────────────────

function getTime(): SystemResult {
  const now = new Date();
  return {
    ok: true,
    content: [
      `🕐 **Current Time**`,
      ``,
      `- Local:  ${now.toLocaleTimeString()}`,
      `- UTC:    ${now.toUTCString()}`,
      `- ISO:    ${now.toISOString()}`,
      `- Unix:   ${Math.floor(now.getTime() / 1000)}`,
    ].join('\n'),
  };
}

function getDate(): SystemResult {
  const now = new Date();
  return {
    ok: true,
    content: [
      `📅 **Current Date**`,
      ``,
      `- Local:  ${now.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' })}`,
      `- UTC:    ${now.toUTCString().slice(0, 16)}`,
      `- ISO:    ${now.toISOString().slice(0, 10)}`,
    ].join('\n'),
  };
}

function getUptime(): SystemResult {
  const upSec = process.uptime();
  const os = require('os') as typeof import('os');
  const sysUpSec = os.uptime();
  return {
    ok: true,
    content: [
      `⏱️ **Uptime**`,
      ``,
      `- Process uptime:  ${formatUptime(upSec)}`,
      `- System uptime:   ${formatUptime(sysUpSec)}`,
    ].join('\n'),
  };
}

function getPlatform(): SystemResult {
  const os = require('os') as typeof import('os');
  const memTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  const memFree  = (os.freemem()  / 1024 / 1024 / 1024).toFixed(1);
  return {
    ok: true,
    content: [
      `💻 **System Info**`,
      ``,
      `- OS:       ${os.type()} ${os.release()} (${os.platform()})`,
      `- Arch:     ${os.arch()}`,
      `- CPUs:     ${os.cpus().length}x ${os.cpus()[0]?.model ?? 'unknown'}`,
      `- Memory:   ${memFree} GB free / ${memTotal} GB total`,
      `- Hostname: ${os.hostname()}`,
      `- Node.js:  ${process.version}`,
    ].join('\n'),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function runSystemTool(input: string): SystemResult {
  const t = input.toLowerCase();

  if (/\btime\b/.test(t) && !/\bdate\b/.test(t)) {
    logger.debug('system: time query');
    return getTime();
  }

  if (/\bdate\b/.test(t) || /\btoday\b/.test(t)) {
    logger.debug('system: date query');
    return getDate();
  }

  if (/\buptime\b/.test(t)) {
    logger.debug('system: uptime query');
    return getUptime();
  }

  if (/\b(platform|os|operating\s*system|system\s*info|hardware)\b/.test(t)) {
    logger.debug('system: platform query');
    return getPlatform();
  }

  // Default: return both time and date
  const time = getTime();
  const date = getDate();
  return {
    ok: true,
    content: `${time.content}\n\n${date.content}`,
  };
}
