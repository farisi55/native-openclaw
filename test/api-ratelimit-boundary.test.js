const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  startApiServer,
  clearRateLimitMap,
  isLoopbackHost,
} = require('../dist/api/server');
const { SessionManager } = require('../dist/storage/session-manager');
const { SettingsManager } = require('../dist/storage/settings-manager');
const { createMessage } = require('../dist/types/message');

const CHAT_PATH = '/native-openclaw/v1/chat';

const provider = {
  id: 'fake',
  displayName: 'Fake Provider',
  async listModels() {
    return [{ id: 'fake-model', name: 'fake-model', contextWindow: 4096, supportsTools: false, supportsVision: false }];
  },
  async chat() {
    return {
      message: createMessage({ role: 'assistant', content: 'provider reply' }),
      model: 'fake-model',
      latencyMs: 1,
    };
  },
};

async function createDeps(dataDir) {
  const sessions = new SessionManager(dataDir);
  const settings = new SettingsManager(dataDir);
  await settings.setDefaultProvider('fake');
  await settings.setDefaultModelForProvider('fake', 'fake-model');

  return {
    providers: new Map([['fake', provider]]),
    skillRegistry: { activeIds: [], size: 0 },
    sessions,
    settings,
    toolRegistry: {},
    orchestrator: {
      async turn(input) {
        const session = input.sessionId
          ? (await sessions.get(input.sessionId)).value
          : (await sessions.create({ providerId: 'fake', model: 'fake-model' })).value;
        return {
          chatResponse: {
            message: createMessage({ role: 'assistant', content: `echo: ${input.userInput}` }),
            model: 'fake-model',
            latencyMs: 1,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
          assistantText: `echo: ${input.userInput}`,
          session,
          newSession: false,
          wasAction: false,
          flow: [{ stage: 'final' }],
          toolsUsed: [],
          toolSteps: 0,
          usedFallback: false,
        };
      },
    },
  };
}

async function withTestServer(fn, opts = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-api-ratelimit-'));
  const deps = await createDeps(dataDir);
  const api = await startApiServer(deps, {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    ...opts,
  });

  try {
    await fn(api);
  } finally {
    await api.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function withEnv(overrides, fn) {
  const snapshot = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  clearRateLimitMap();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(overrides)) {
        if (snapshot[key] === undefined) delete process.env[key];
        else process.env[key] = snapshot[key];
      }
      clearRateLimitMap();
    });
}

function postJson(api, body = { message: 'hello' }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: api.host,
      port: api.port,
      path: CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text ? JSON.parse(text) : {},
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('exactly at limit returns 200', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '3' }, async () => {
    await withTestServer(async (api) => {
      for (let i = 0; i < 3; i += 1) {
        const response = await postJson(api, { message: `message ${i}` });
        assert.equal(response.status, 200);
      }
    });
  });
});

test('one over limit returns 429', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '3' }, async () => {
    await withTestServer(async (api) => {
      for (let i = 0; i < 3; i += 1) {
        const response = await postJson(api, { message: `message ${i}` });
        assert.equal(response.status, 200);
      }

      const response = await postJson(api, { message: 'over limit' });
      assert.equal(response.status, 429);
      assert.ok(Array.isArray(response.body.error_detail));
      assert.match(response.body.error_detail[0], /rate limit/i);
    });
  });
});

test('Retry-After header present on 429 response', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '1' }, async () => {
    await withTestServer(async (api) => {
      assert.equal((await postJson(api, { message: 'one' })).status, 200);
      const response = await postJson(api, { message: 'two' });
      assert.equal(response.status, 429);
      const retryAfter = response.headers['retry-after'];
      assert.equal(typeof retryAfter, 'string');
      assert.ok(Number.parseInt(retryAfter, 10) > 0);
    });
  });
});

test('clearRateLimitMap resets counter', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_MAX: '3' }, async () => {
    await withTestServer(async (api) => {
      for (let i = 0; i < 3; i += 1) {
        const response = await postJson(api, { message: `message ${i}` });
        assert.equal(response.status, 200);
      }

      clearRateLimitMap();
      const response = await postJson(api, { message: 'after clear' });
      assert.notEqual(response.status, 429);
    });
  });
});

test('isLoopbackHost unit tests', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost(''), false);
});

test('rate limit disabled when RATE_LIMIT_ENABLED=false', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX: '1' }, async () => {
    await withTestServer(async (api) => {
      for (let i = 0; i < 5; i += 1) {
        const response = await postJson(api, { message: `message ${i}` });
        assert.notEqual(response.status, 429);
      }
    });
  });
});
