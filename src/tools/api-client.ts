/**
 * tools/api-client.ts
 * Full curl-equivalent HTTP request builder.
 *
 * Supports: GET POST PUT PATCH DELETE HEAD OPTIONS
 * Supports: endpoint+port+path assembly, query params, headers, JSON/text body,
 *           path param substitution, timeout, redirect following.
 *
 * Example equivalent of:
 *   curl -L 'http://localhost:3000/api/default/lids/136584825463003%40lid' \
 *        -H 'X-Api-Key: 637dfeee-0873-40d0-84b8-3cc0a06ca5c9'
 *
 *   { endpoint: "http://localhost", port: 3000,
 *     path: "/api/default/lids/136584825463003%40lid",
 *     headers: { "X-Api-Key": "637dfeee-0873-40d0-84b8-3cc0a06ca5c9" } }
 */

import { createLogger } from '../utils/logger';
import { getOptionalEnv } from '../config/env';
import { networkFetch } from '../network';

const logger = createLogger('tool:api-client');
const DEFAULT_TIMEOUT = 20_000;

// ─── Input type ───────────────────────────────────────────────────────────────

export interface ApiClientInput {
  /** Base endpoint, e.g. "http://localhost" or "https://api.example.com" */
  endpoint?: string;
  /** Optional port number. */
  port?: number;
  /** Path to append. */
  path?: string;
  /** Full URL (overrides endpoint+port+path if provided). */
  url?: string;
  /** HTTP method. Default: GET. */
  method?: string;
  /** Request headers (object or array of "Key: Value" strings). */
  headers?: Record<string, string> | string[] | string;
  /** Query parameters to append as ?key=value. */
  params?: Record<string, string> | string;
  /** Request body — string, JSON object, or JSON string. */
  body?: string | Record<string, unknown>;
  /** Timeout in ms. */
  timeout?: number;
  /** Path parameters for substitution, e.g. { id: "123" } → /users/{id} → /users/123 */
  pathParams?: Record<string, string>;
  /** Follow redirects. Default: true. */
  followRedirects?: boolean;
  /** Raw query string appended directly (for pre-encoded values). */
  query?: string;
}

export interface ApiResult {
  ok: boolean;
  content: string;
  status?: number;
  url?: string;
  headers?: Record<string, string>;
}

// ─── URL builder ──────────────────────────────────────────────────────────────

function buildUrl(input: ApiClientInput): string {
  // Full URL takes precedence
  if (input.url) return applyPathParams(input.url, input.pathParams);

  // Assemble from parts
  const base = (
    getOptionalEnv('INTERNAL_API_BASE_URL', 'http://localhost:3000') ?? 'http://localhost:3000'
  ).replace(/\/$/, '');

  let url = input.endpoint ? input.endpoint.replace(/\/$/, '') : base;
  if (input.port) {
    // Insert port if not already in endpoint
    try {
      const parsed = new URL(url);
      parsed.port = String(input.port);
      url = parsed.origin + (parsed.pathname !== '/' ? parsed.pathname : '');
    } catch {
      url = `${url}:${input.port}`;
    }
  }
  if (input.path) {
    const p = input.path.startsWith('/') ? input.path : '/' + input.path;
    url += applyPathParams(p, input.pathParams);
  }
  return url;
}

function applyPathParams(path: string, params?: Record<string, string>): string {
  if (!params) return path;
  return Object.entries(params).reduce(
    (p, [k, v]) => p.replace(new RegExp(`\\{${k}\\}`, 'g'), encodeURIComponent(v)),
    path
  );
}

function buildQuery(input: ApiClientInput, base: string): string {
  const parts: string[] = [];

  // Raw query string
  if (input.query) parts.push(input.query.replace(/^\?/, ''));

  // Params object
  if (input.params) {
    if (typeof input.params === 'string') {
      parts.push(input.params.replace(/^\?/, ''));
    } else {
      for (const [k, v] of Object.entries(input.params)) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
      }
    }
  }

  if (parts.length === 0) return base;
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + parts.join('&');
}

function buildHeaders(input: ApiClientInput): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!input.headers) return headers;

  if (Array.isArray(input.headers)) {
    // ["X-Api-Key: abc123", "Authorization: Bearer tok"]
    for (const h of input.headers) {
      const idx = h.indexOf(':');
      if (idx > 0) {
        const key = h.slice(0, idx).trim();
        const val = h.slice(idx + 1).trim();
        headers[key] = val;
      }
    }
  } else if (typeof input.headers === 'string') {
    // Single "Key: Value" string
    const idx = input.headers.indexOf(':');
    if (idx > 0) {
      headers[input.headers.slice(0, idx).trim()] = input.headers.slice(idx + 1).trim();
    }
  } else {
    Object.assign(headers, input.headers);
  }

  return headers;
}

function buildBody(input: ApiClientInput): { body: string | undefined; contentType: string | null } {
  if (!input.body) return { body: undefined, contentType: null };

  if (typeof input.body === 'object') {
    return { body: JSON.stringify(input.body), contentType: 'application/json' };
  }

  // Try to detect if it's a JSON string
  try {
    JSON.parse(input.body);
    return { body: input.body, contentType: 'application/json' };
  } catch {
    return { body: input.body, contentType: 'text/plain' };
  }
}

function formatResponse(data: unknown, status: number, url: string, respHeaders: Record<string, string>): string {
  const icon = status >= 200 && status < 300 ? '✅' : '⚠️';
  let body: string;
  if (typeof data === 'string') {
    body = data.length > 2000 ? data.slice(0, 2000) + '\n…[truncated]' : data;
  } else {
    const j = JSON.stringify(data, null, 2);
    body = j.length > 2000 ? j.slice(0, 2000) + '\n…[truncated]' : j;
  }

  const headerStr = Object.entries(respHeaders)
    .slice(0, 5)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  return [
    `${icon} **API Response** — \`${url}\` (HTTP ${status})`,
    headerStr ? `\nResponse Headers:\n${headerStr}` : '',
    '\n```',
    body,
    '```',
  ].filter(Boolean).join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runApiClient(
  input: ApiClientInput | string
): Promise<ApiResult> {
  // Accept plain string path for backward compat
  const opts: ApiClientInput = typeof input === 'string' ? { path: input } : input;

  let url = buildUrl(opts);
  url = buildQuery(opts, url);

  const method  = (opts.method ?? 'GET').toUpperCase();
  const headers = buildHeaders(opts);
  const { body, contentType } = buildBody(opts);
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

  if (contentType && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = contentType;
  }

  logger.debug('api-client request', { method, url, headers: Object.keys(headers) });

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const init: RequestInit = {
      method,
      signal: ctrl.signal,
      headers,
      redirect: opts.followRedirects === false ? 'manual' : 'follow',
    };
    if (body !== undefined) init.body = body;

    const res = await networkFetch(url, init);
    clearTimeout(timer);

    // Collect response headers
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    const ct = res.headers.get('content-type') ?? '';
    let data: unknown;
    if (ct.includes('json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    logger.debug('api-client response', { status: res.status, url });

    return {
      ok:      res.ok,
      content: formatResponse(data, res.status, url, respHeaders),
      status:  res.status,
      url,
      headers: respHeaders,
    };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error && e.name === 'AbortError'
      ? `Request timed out after ${timeout / 1000}s`
      : String(e);
    return { ok: false, content: `❌ API call failed: ${msg}\nURL: ${url}`, url };
  }
}
