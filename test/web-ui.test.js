const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { startWebUiServer, startWebUiServerIfEnabled } = require('../dist/web-ui');
const { SessionManager } = require('../dist/storage/session-manager');
const { SettingsManager } = require('../dist/storage/settings-manager');
const { createMessage } = require('../dist/types/message');

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
      latencyMs: 7,
    };
  },
};

function config(overrides = {}) {
  return {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    username: 'admin',
    password: 'secret',
    sessionSecret: 'test-session-secret',
    cookieName: 'native_openclaw_test',
    sessionTtlMs: 86_400_000,
    ...overrides,
  };
}

async function withDeps(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-web-ui-test-'));
  try {
    const sessions = new SessionManager(dataDir);
    const settings = new SettingsManager(dataDir);
    await settings.setDefaultProvider('fake');
    await settings.setDefaultModelForProvider('fake', 'fake-model');

    const deps = {
      providers: new Map([['fake', provider]]),
      skillRegistry: { activeIds: [], size: 0 },
      sessions,
      settings,
      toolRegistry: {},
      orchestrator: {
        calls: 0,
        async turn(input) {
          this.calls += 1;
          const session = input.sessionId
            ? (await sessions.get(input.sessionId)).value
            : (await sessions.create({ providerId: 'fake', model: 'fake-model' })).value;
          return {
            chatResponse: {
              message: createMessage({ role: 'assistant', content: `web reply: ${input.userInput}` }),
              model: 'fake-model',
              latencyMs: 12,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
            },
            assistantText: `web reply: ${input.userInput}`,
            session,
            newSession: false,
            wasAction: false,
            flow: [{ stage: 'final' }],
            toolsUsed: ['mock-tool'],
            toolSteps: 1,
            usedFallback: false,
          };
        },
      },
    };

    await fn(deps);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withServer(fn, overrides = {}) {
  await withDeps(async (deps) => {
    const server = await startWebUiServer(deps, config(overrides));
    try {
      await fn(server, deps);
    } finally {
      await server.close();
    }
  });
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie');
  assert.ok(raw);
  return raw.split(';')[0];
}

test('WEB_UI_ENABLED=false does not start Web UI server', async () => {
  await withDeps(async (deps) => {
    const started = await startWebUiServerIfEnabled(deps, config({ enabled: false }));
    assert.equal(started, null);
  });
});

test('Web UI starts and health endpoint responds', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/health`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'native-openclaw-web-ui');
  });
});

test('GET / without auth redirects to login', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
  });
});

test('POST /login with wrong credentials returns login error', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'bad' }),
      redirect: 'manual',
    });
    const text = await response.text();
    assert.equal(response.status, 401);
    assert.match(text, /Invalid username or password/);
    assert.equal(response.headers.get('set-cookie'), null);
  });
});

test('POST /login with correct credentials sets HTTP-only cookie', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie') ?? '';
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });
});

test('POST /chat without auth returns 401', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    const body = await response.json();
    assert.equal(response.status, 401);
    assert.equal(body.ok, false);
  });
});

test('POST /chat with auth calls existing chat handler and returns metadata', async () => {
  await withServer(async (server, deps) => {
    const login = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const cookie = cookieFrom(login);

    const response = await fetch(`${server.url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ message: 'halo' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.result, 'web reply: halo');
    assert.equal(body.model, 'fake-model');
    assert.equal(body.provider, 'fake');
    assert.equal(body.responseTime, '12 ms');
    assert.deepEqual(body.tools, ['mock-tool']);
    assert.equal(typeof body.sessionId, 'string');
    assert.equal(deps.orchestrator.calls, 1);
  });
});

test('POST /chat rejects empty message', async () => {
  await withServer(async (server) => {
    const login = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const response = await fetch(`${server.url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFrom(login) },
      body: JSON.stringify({ message: '   ' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /empty/);
  });
});

test('Web UI responses include security headers', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/login`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  });
});
