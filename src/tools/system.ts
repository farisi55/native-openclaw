/**
 * tools/system.ts
 * System info tool — time, date, uptime, platform.
 * query param dispatches to the correct handler.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('tool:system');

export interface SystemResult {
  ok: boolean;
  content: string;
}

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
      `- Local:  ${now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
      `- UTC:    ${now.toUTCString().slice(0, 16)}`,
      `- ISO:    ${now.toISOString().slice(0, 10)}`,
    ].join('\n'),
  };
}

function getUptime(): SystemResult {
  const os = require('os') as typeof import('os');
  const upSec  = process.uptime();
  const sysSec = os.uptime();
  return {
    ok: true,
    content: [
      `⏱️ **Uptime**`,
      ``,
      `- Process uptime:  ${formatUptime(upSec)}`,
      `- System uptime:   ${formatUptime(sysSec)}`,
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

export function runSystemTool(input: string | { query?: string } | Record<string, unknown>): SystemResult {
  const query = typeof input === 'string'
    ? input
    : (input as Record<string, unknown>)['query'] as string | undefined ?? 'time';

  const t = (query ?? '').toLowerCase();

  logger.debug('system tool', { query: t });

  if (/\bdate\b/.test(t) && !/\btime\b/.test(t)) return getDate();
  if (/\btime\b/.test(t) && !/\bdate\b/.test(t)) return getTime();
  if (/\buptime\b/.test(t))   return getUptime();
  if (/\b(platform|os|system|hardware|info)\b/.test(t)) return getPlatform();

  // Default: both time and date
  const time = getTime();
  const date = getDate();
  return { ok: true, content: `${time.content}\n\n${date.content}` };
}
