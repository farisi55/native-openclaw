import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config';
import type { ApiConfig, ApiDependencies, ApiRuntimeState, ChatApiResponse } from './types';
import { createApiRuntimeState, handleChatRoute } from './routes';
import { createLogger } from '../utils/logger';
import { createHash, timingSafeEqual } from 'crypto';

const logger = createLogger('api:server');
const CHAT_PATH = '/native-openclaw/v1/chat';
const MAX_BODY_BYTES = 1_000_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CLEANUP_MS = 5 * 60_000;
const TRUSTED_PROXY_IPS = parseTrustedProxyIps(process.env['TRUSTED_PROXY_IPS'] ?? '');

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

export function clearRateLimitMap(): void {
  rateLimitBuckets.clear();
}

export interface StartedApiServer {
  server: Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export function loadApiConfig(): ApiConfig {
  const authToken = getOptionalEnv('API_AUTH_TOKEN');
  const cfg: ApiConfig = {
    enabled: getEnvBool('API_ENABLED', false),
    host: getOptionalEnv('API_HOST', '127.0.0.1') ?? '127.0.0.1',
    port: getEnvInt('API_PORT', 18789),
  };
  if (authToken) cfg.authToken = authToken;
  return cfg;
}

/**
 * HARDENING [C3]: adds conservative API security headers to every response.
 */
function addSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cache-Control', 'no-store');

  const corsOrigin = getOptionalEnv('API_CORS_ORIGIN');
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: ChatApiResponse,
  headers: Record<string, string> = {}
): void {
  const json = JSON.stringify(body);
  addSecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

function errorBody(error: string): ChatApiResponse {
  return {
    model: null,
    provider: null,
    result: null,
    token: null,
    responseTime: '0 ms',
    tools: [],
    flow: [],
    sessionId: null,
    error_detail: [error],
  };
}

function isAuthorized(req: IncomingMessage, cfg: ApiConfig): boolean {
  if (!cfg.authToken) {
    const ip = requestIp(req);
    return ip === '127.0.0.1' || ip === '::1';
  }

  const actual = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const expected = `Bearer ${cfg.authToken}`;
  const actualHash = createHash('sha256').update(actual, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(actualHash, expectedHash); // HARDENING [C1]
}

function rateLimitMax(): number {
  return Math.max(1, getEnvInt('RATE_LIMIT_MAX', 10));
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Rate limiting is bypassed for loopback-only API hosts by default.
 * Set RATE_LIMIT_ENABLED=true to explicitly enable it on loopback, or false to disable it elsewhere.
 */
function isRateLimitEnabled(cfg: ApiConfig): boolean {
  const configured = getOptionalEnv('RATE_LIMIT_ENABLED');
  if (configured !== undefined) {
    return getEnvBool('RATE_LIMIT_ENABLED', true);
  }

  if (isLoopbackHost(cfg.host)) {
    return false;
  }

  return getEnvBool('RATE_LIMIT_ENABLED', true);
}

function parseTrustedProxyIps(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((ip) => normalizeIp(ip.trim()))
      .filter(Boolean)
  );
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

function forwardedForLast(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
  const last = parts.at(-1);
  return last ? normalizeIp(last) : null;
}

export function requestIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress;
  if (!remote) return 'unknown';
  const normalizedRemote = normalizeIp(remote);

  if (TRUSTED_PROXY_IPS.size > 0 && TRUSTED_PROXY_IPS.has(normalizedRemote)) {
    return forwardedForLast(req) ?? normalizedRemote;
  }

  return normalizedRemote;
}

function consumeRateLimit(req: IncomingMessage): boolean {
  const now = Date.now();
  const key = requestIp(req);
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (existing.count >= rateLimitMax()) return false;
  existing.count += 1;
  return true;
}

function cleanupRateLimitMap(): void {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('Request body too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const parsed = raw ? JSON.parse(raw) : {};
        settled = true;
        resolve(parsed);
      } catch {
        fail(new Error('Invalid JSON request body.'));
      }
    });
    req.on('error', (error) => fail(error));
  });
}

export async function startApiServer(
  deps: ApiDependencies,
  cfg: ApiConfig = loadApiConfig()
): Promise<StartedApiServer> {
  const state: ApiRuntimeState = await createApiRuntimeState(deps);
  const rateLimitEnabled = isRateLimitEnabled(cfg);
  if (!cfg.authToken && !isLoopbackHost(cfg.host)) {
    logger.warn('API_AUTH_TOKEN not set; API will only authorize loopback clients', {
      host: cfg.host,
    });
  }

  const cleanupTimer = rateLimitEnabled
    ? setInterval(cleanupRateLimitMap, RATE_LIMIT_CLEANUP_MS)
    : null;
  cleanupTimer?.unref();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? cfg.host}`);

    if (req.method === 'OPTIONS') {
      addSecurityHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || url.pathname !== CHAT_PATH) {
      sendJson(res, 404, errorBody('Not found.'));
      return;
    }

    if (!isAuthorized(req, cfg)) {
      sendJson(res, 401, errorBody('Unauthorized.'));
      return;
    }

    if (rateLimitEnabled && !consumeRateLimit(req)) {
      sendJson(res, 429, errorBody('Rate limit exceeded.'), { 'Retry-After': '60' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await handleChatRoute(body as Record<string, unknown>, deps, state);
      sendJson(res, result.status, result.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 400, errorBody(message));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.port;
  logger.info(`API server listening on http://${cfg.host}:${port}${CHAT_PATH}`);

  return {
    server,
    host: cfg.host,
    port,
    close: () => new Promise((resolve, reject) => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      clearRateLimitMap();
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

export async function startApiServerIfEnabled(deps: ApiDependencies): Promise<StartedApiServer | null> {
  const cfg = loadApiConfig();
  if (!cfg.enabled) {
    logger.debug('API server disabled');
    return null;
  }
  return startApiServer(deps, cfg);
}
