const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { clearRateLimitMap, startApiServer, startApiServerIfEnabled } = require('../dist/api');
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

test('rate limit is active by default (no env override)', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: undefined, RATE_LIMIT_MAX: '2' }, async () => {
    await withDeps(async (deps) => {
      const api = await startApiServer(deps, {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://${api.host}:${api.port}`;
        assert.equal((await postJson(baseUrl, { message: 'one' })).status, 200);
        assert.equal((await postJson(baseUrl, { message: 'two' })).status, 200);
        assert.equal((await postJson(baseUrl, { message: 'three' })).status, 429);
      } finally {
        await api.close();
      }
    });
  });
});

test('rate limit can be disabled via RATE_LIMIT_ENABLED=false', async () => {
  await withEnv({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX: '2' }, async () => {
    await withDeps(async (deps) => {
      const api = await startApiServer(deps, {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
      });

      try {
        const baseUrl = `http://${api.host}:${api.port}`;
        for (const message of ['one', 'two', 'three']) {
          const response = await postJson(baseUrl, { message });
          assert.notEqual(response.status, 429);
        }
      } finally {
        await api.close();
      }
    });
  });
});

test('API rejects request body exceeding 1MB', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
    });

    try {
      // Build a payload just over 1MB
      const oversizedMessage = 'x'.repeat(1_050_000);
      const res = await postJson(`http://${api.host}:${api.port}`, {
        message: oversizedMessage,
      });

      // Server must respond 400, not crash or hang
      assert.equal(res.status, 400, 'oversized body must return HTTP 400');
      assert.ok(
        Array.isArray(res.body.error_detail) && res.body.error_detail.length > 0,
        'error_detail must be non-empty'
      );
    } finally {
      await api.close();
    }
  });
});

test('GET request to chat endpoint returns 404', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://${api.host}:${api.port}/native-openclaw/v1/chat`, {
        method: 'GET',
      });
      assert.equal(res.status, 404);
      const body = await res.json();
      assert.ok(Array.isArray(body.error_detail));
    } finally {
      await api.close();
    }
  });
});

test('POST to wrong path returns 404', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://${api.host}:${api.port}/wrong/path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });
      assert.equal(res.status, 404);
    } finally {
      await api.close();
    }
  });
});

test('empty message returns 400 with descriptive error', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://${api.host}:${api.port}/native-openclaw/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.error_detail[0].includes('non-empty'));
    } finally {
      await api.close();
    }
  });
});

test('malformed JSON body returns 400', async () => {
  await withDeps(async (deps) => {
    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const res = await fetch(`http://${api.host}:${api.port}/native-openclaw/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      assert.equal(res.status, 400);
    } finally {
      await api.close();
    }
  });
});

test('API flow reason is sanitized before response', async () => {
  await withDeps(async (deps) => {
    deps.orchestrator.turn = async (input) => {
      const session = (await deps.sessions.get(input.sessionId)).value;
      return {
        chatResponse: {
          message: createMessage({ role: 'assistant', content: 'clean reply' }),
          model: 'fake-model',
          latencyMs: 12,
        },
        assistantText: 'clean reply',
        session,
        newSession: false,
        wasAction: false,
        flow: [{ stage: 'reasoning', reason: 'The user is asking from memory analysis: use tool' }],
        toolsUsed: [],
        toolSteps: 0,
        usedFallback: false,
      };
    };

    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const res = await postJson(`http://${api.host}:${api.port}`, { message: 'hello' });
      assert.equal(res.status, 200);
      const serializedFlow = JSON.stringify(res.body.flow).toLowerCase();
      assert.doesNotMatch(serializedFlow, /the user is asking|from memory|analysis:/);
    } finally {
      await api.close();
    }
  });
});

function loadServerModuleWithTrustedProxyEnv(value) {
  const modulePath = require.resolve('../dist/api/server');
  const previous = process.env.TRUSTED_PROXY_IPS;
  if (value === undefined) delete process.env.TRUSTED_PROXY_IPS;
  else process.env.TRUSTED_PROXY_IPS = value;
  delete require.cache[modulePath];
  const mod = require('../dist/api/server');
  if (previous === undefined) delete process.env.TRUSTED_PROXY_IPS;
  else process.env.TRUSTED_PROXY_IPS = previous;
  return mod;
}

function mockReq(remoteAddress, forwardedFor) {
  return {
    socket: { remoteAddress },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  };
}

test('requestIp ignores X-Forwarded-For when no trusted proxy configured', () => {
  const { requestIp } = loadServerModuleWithTrustedProxyEnv(undefined);
  assert.equal(
    requestIp(mockReq('203.0.113.10', '127.0.0.1')),
    '203.0.113.10'
  );
});

test('requestIp uses X-Forwarded-For last entry when remoteAddress is trusted proxy', () => {
  const { requestIp } = loadServerModuleWithTrustedProxyEnv('10.0.0.1');
  assert.equal(
    requestIp(mockReq('::ffff:10.0.0.1', '198.51.100.7, 203.0.113.9')),
    '203.0.113.9'
  );
});

test('requestIp returns unknown when remoteAddress is undefined and no trusted proxy', () => {
  const { requestIp } = loadServerModuleWithTrustedProxyEnv(undefined);
  assert.equal(
    requestIp(mockReq(undefined, '127.0.0.1')),
    'unknown'
  );
});
