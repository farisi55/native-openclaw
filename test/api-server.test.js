const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { startApiServer, startApiServerIfEnabled } = require('../dist/api');
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

async function withDeps(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-api-test-'));
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
        async turn(input) {
          const session = input.sessionId
            ? (await sessions.get(input.sessionId)).value
            : (await sessions.create({ providerId: 'fake', model: 'fake-model' })).value;
          return {
            chatResponse: {
              message: createMessage({ role: 'assistant', content: `echo: ${input.userInput}` }),
              model: 'fake-model',
              latencyMs: 12,
              usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
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

    await fn(deps);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function postJson(baseUrl, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/native-openclaw/v1/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('API_ENABLED=false does not start server', async () => {
  const previous = process.env.API_ENABLED;
  process.env.API_ENABLED = 'false';
  try {
    const started = await startApiServerIfEnabled({});
    assert.equal(started, null);
  } finally {
    if (previous === undefined) delete process.env.API_ENABLED;
    else process.env.API_ENABLED = previous;
  }
});

test('API server starts and chat response has expected shape', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const res = await postJson(`http://${api.host}:${api.port}`, { message: 'hello apa kabar' });
      assert.equal(res.status, 200);
      assert.equal(res.body.model, 'fake-model');
      assert.equal(res.body.provider, 'fake');
      assert.equal(res.body.result, 'echo: hello apa kabar');
      assert.equal(res.body.token, '5 token');
      assert.equal(res.body.responseTime, '12 ms');
      assert.deepEqual(res.body.tools, []);
      assert.ok(Array.isArray(res.body.flow));
      assert.equal(res.body.error_detail.length, 0);
      assert.equal(typeof res.body.sessionId, 'string');
    } finally {
      await api.close();
    }
  });
});

test('API supports CLI command messages like /help', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    });

    try {
      const res = await postJson(`http://${api.host}:${api.port}`, { message: '/help' });
      assert.equal(res.status, 200);
      assert.match(res.body.result, /Command Reference/);
      assert.equal(res.body.flow[0].type, 'command');
      assert.equal(res.body.error_detail.length, 0);
    } finally {
      await api.close();
    }
  });
});

test('API_AUTH_TOKEN is enforced when configured', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      authToken: 'secret',
    });

    try {
      const unauthorized = await postJson(`http://${api.host}:${api.port}`, { message: 'hello' });
      assert.equal(unauthorized.status, 401);
      assert.match(unauthorized.body.error_detail[0], /Unauthorized/);

      const authorized = await postJson(`http://${api.host}:${api.port}`, { message: 'hello' }, 'secret');
      assert.equal(authorized.status, 200);
      assert.equal(authorized.body.result, 'echo: hello');
    } finally {
      await api.close();
    }
  });
});

