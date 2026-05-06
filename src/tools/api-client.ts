/**
 * tools/api-client.ts
 * API client tool — makes GET requests to an internal or external API.
 *
 * Base URL from env: INTERNAL_API_BASE_URL (default: http://localhost:3000)
 *
 * Patterns (detected by tool-handler.ts):
 *   "get data from API /path"
 *   "call API /path"
 *   "fetch API /path"
 *   "api get /path"
 *   "query /api/..."
 */

import { createLogger } from '../utils/logger';
import { getOptionalEnv } from '../config/env';

const logger = createLogger('tool:api-client');
const TIMEOUT_MS = 20_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiResult {
  ok: boolean;
  content: string;
  status?: number;
  url?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatResponse(data: unknown, status: number, url: string): string {
  const statusIcon = status >= 200 && status < 300 ? '✅' : '⚠️';
  let body: string;

  if (typeof data === 'string') {
    body = data.length > 1500 ? data.slice(0, 1500) + '\n…[truncated]' : data;
  } else {
    const json = JSON.stringify(data, null, 2);
    body = json.length > 1500 ? json.slice(0, 1500) + '\n…[truncated]' : json;
  }

  return [
    `${statusIcon} **API Response** — \`${url}\` (HTTP ${status})`,
    '',
    '```json',
    body,
    '```',
  ].join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runApiClient(path: string): Promise<ApiResult> {
  const baseUrl = (
    getOptionalEnv('INTERNAL_API_BASE_URL', 'http://localhost:3000') ??
    'http://localhost:3000'
  ).replace(/\/$/, '');

  // Build full URL: if path is already an absolute URL, use as-is
  const url = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;

  logger.debug('api-client: GET', { url });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'native-openclaw/5.0',
      },
    });
    clearTimeout(timer);

    const ct = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (ct.includes('json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return {
      ok: res.ok,
      content: formatResponse(data, res.status, url),
      status: res.status,
      url,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error && e.name === 'AbortError'
      ? `Request timed out after ${TIMEOUT_MS / 1000}s`
      : String(e);
    return {
      ok: false,
      content: `❌ API call failed: ${msg}\nURL: ${url}`,
      url,
    };
  }
}
