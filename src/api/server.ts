import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config';
import type { ApiConfig, ApiDependencies, ApiRuntimeState, ChatApiResponse } from './types';
import { createApiRuntimeState, handleChatRoute } from './routes';
import { createLogger } from '../utils/logger';

const logger = createLogger('api:server');
const CHAT_PATH = '/native-openclaw/v1/chat';
const MAX_BODY_BYTES = 1_000_000;

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

function sendJson(res: ServerResponse, status: number, body: ChatApiResponse): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
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
  if (!cfg.authToken) return true;
  return req.headers.authorization === `Bearer ${cfg.authToken}`;
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
        settled = true;
        resolve(raw ? JSON.parse(raw) : {});
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? cfg.host}`);

    if (req.method !== 'POST' || url.pathname !== CHAT_PATH) {
      sendJson(res, 404, errorBody('Not found.'));
      return;
    }

    if (!isAuthorized(req, cfg)) {
      sendJson(res, 401, errorBody('Unauthorized.'));
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
