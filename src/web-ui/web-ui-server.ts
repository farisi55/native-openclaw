import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { createLogger } from '../utils/logger';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { createApiRuntimeState, handleChatRoute } from '../api/routes';
import type { ApiRuntimeState } from '../api/types';
import {
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
  validateCredentials,
} from './web-ui-auth';
import type { StartedWebUiServer, WebUiChatResponse, WebUiConfig, WebUiDependencies } from './web-ui-types';

const logger = createLogger('web-ui');
const CHAT_BODY_LIMIT_BYTES = 64 * 1024;
const LOGIN_BODY_LIMIT_BYTES = 8 * 1024;
const CHAT_RATE_WINDOW_MS = 60_000;
const CHAT_RATE_LIMIT = 30;

interface RateBucket {
  count: number;
  resetAt: number;
}

const chatRateBuckets = new Map<string, RateBucket>();

export function loadWebUiConfig(): WebUiConfig {
  return {
    enabled: getEnvBool('WEB_UI_ENABLED', false),
    host: getOptionalEnv('WEB_UI_HOST', '0.0.0.0') ?? '0.0.0.0',
    port: getEnvInt('WEB_UI_PORT', 18790),
    username: getOptionalEnv('WEB_UI_USERNAME', 'admin') ?? 'admin',
    password: getOptionalEnv('WEB_UI_PASSWORD', 'change-me') ?? 'change-me',
    sessionSecret: getOptionalEnv('WEB_UI_SESSION_SECRET', 'change-this-secret') ?? 'change-this-secret',
    cookieName: getOptionalEnv('WEB_UI_COOKIE_NAME', 'native_openclaw_webui') ?? 'native_openclaw_webui',
    sessionTtlMs: getEnvInt('WEB_UI_SESSION_TTL_MS', 86_400_000),
  };
}

export async function startWebUiServerIfEnabled(
  deps: WebUiDependencies,
  config: WebUiConfig = loadWebUiConfig()
): Promise<StartedWebUiServer | null> {
  if (!config.enabled) {
    logger.debug('Web UI disabled');
    return null;
  }
  return startWebUiServer(deps, config);
}

export async function startWebUiServer(
  deps: WebUiDependencies,
  config: WebUiConfig
): Promise<StartedWebUiServer> {
  const state = await createApiRuntimeState(deps);
  const publicDir = resolvePublicDir();
  const server = createServer((req, res) => {
    handleRequest(req, res, deps, state, config, publicDir).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Web UI request failed', { error: message });
      sendJson(res, 500, { ok: false, error: message });
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const url = `http://${config.host}:${port}`;
  logger.info(`Web UI listening on ${url}`);

  return {
    host: config.host,
    port,
    url,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((err) => err ? reject(err) : resolvePromise());
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUiDependencies,
  state: ApiRuntimeState,
  config: WebUiConfig,
  publicDir: string
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  addSecurityHeaders(res);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, service: 'native-openclaw-web-ui' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/login') {
    if (isAuthenticated(req.headers.cookie, config)) {
      redirect(res, '/');
      return;
    }
    await sendHtml(res, publicDir, 'login.html', { '{{ERROR}}': '' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    await handleLogin(req, res, config, publicDir);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    res.setHeader('Set-Cookie', clearSessionCookie(config));
    redirect(res, '/login');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    if (!isAuthenticated(req.headers.cookie, config)) {
      redirect(res, '/login');
      return;
    }
    await sendHtml(res, publicDir, 'index.html');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/chat') {
    await handleChat(req, res, deps, state, config);
    return;
  }

  if (
    req.method === 'GET' &&
    (['/app.js', '/styles.css', '/favicon.ico'].includes(url.pathname) || url.pathname.startsWith('/assets/'))
  ) {
    await sendStatic(res, publicDir, url.pathname.slice(1));
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found.' });
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  config: WebUiConfig,
  publicDir: string
): Promise<void> {
  const raw = await readBody(req, LOGIN_BODY_LIMIT_BYTES);
  const params = parseLoginBody(raw, req.headers['content-type']);
  const username = params.get('username') ?? '';
  const password = params.get('password') ?? '';

  if (!validateCredentials(username, password, config)) {
    res.statusCode = 401;
    await sendHtml(res, publicDir, 'login.html', { '{{ERROR}}': 'Invalid username or password.' }, false);
    return;
  }

  res.setHeader('Set-Cookie', createSessionCookie(config));
  redirect(res, '/');
}

function parseLoginBody(raw: string, contentType: string | string[] | undefined): URLSearchParams {
  const type = Array.isArray(contentType) ? contentType.join(',') : contentType ?? '';
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return new URLSearchParams({
        username: typeof parsed['username'] === 'string' ? parsed['username'] : '',
        password: typeof parsed['password'] === 'string' ? parsed['password'] : '',
      });
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(raw);
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebUiDependencies,
  state: ApiRuntimeState,
  config: WebUiConfig
): Promise<void> {
  if (!isAuthenticated(req.headers.cookie, config)) {
    sendJson(res, 401, { ok: false, error: 'Authentication required.' });
    return;
  }

  const rateKey = req.socket.remoteAddress ?? 'unknown';
  if (!consumeRateLimit(rateKey)) {
    sendJson(res, 429, { ok: false, error: 'Too many chat requests. Please wait a moment.' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req, CHAT_BODY_LIMIT_BYTES)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid JSON body.';
    sendJson(res, message.includes('too large') ? 413 : 400, { ok: false, error: message });
    return;
  }

  const message = typeof body['message'] === 'string' ? body['message'].trim() : '';
  if (!message) {
    sendJson(res, 400, { ok: false, error: 'Message must not be empty.' });
    return;
  }

  const result = await handleChatRoute(
    {
      message,
      ...(typeof body['sessionId'] === 'string' ? { sessionId: body['sessionId'] } : {}),
    },
    deps,
    state
  );
  const error = result.body.error_detail[0] ?? null;
  const response: WebUiChatResponse = {
    ok: result.status < 400 && !error,
    result: result.body.result ?? error ?? '',
    model: result.body.model,
    provider: result.body.provider,
    responseTime: result.body.responseTime,
    tools: result.body.tools,
    sessionId: result.body.sessionId,
    error,
  };
  sendJson(res, result.status, response);
}

function consumeRateLimit(key: string): boolean {
  const now = Date.now();
  const existing = chatRateBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    chatRateBuckets.set(key, { count: 1, resetAt: now + CHAT_RATE_WINDOW_MS });
    return true;
  }
  if (existing.count >= CHAT_RATE_LIMIT) return false;
  existing.count += 1;
  return true;
}

function addSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location });
  res.end();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  if (!res.headersSent) {
    addSecurityHeaders(res);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
    });
  }
  res.end(json);
}

async function sendHtml(
  res: ServerResponse,
  publicDir: string,
  fileName: string,
  replacements: Record<string, string> = {},
  writeHead = true
): Promise<void> {
  let html = await readFile(join(publicDir, fileName), 'utf-8');
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(key, escapeHtml(value));
  }
  if (writeHead) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
  }
  res.end(html);
}

async function sendStatic(res: ServerResponse, publicDir: string, fileName: string): Promise<void> {
  const filePath = join(publicDir, fileName);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    sendJson(res, 404, { ok: false, error: 'Not found.' });
    return;
  }

  const content = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentType(filePath),
    'Content-Length': content.length,
  });
  res.end(content);
}

function contentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

async function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function resolvePublicDir(): string {
  const candidates = [
    join(__dirname, 'public'),
    resolve(process.cwd(), 'src', 'web-ui', 'public'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Web UI public directory was not found.');
  return found;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
