const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const vm = require('node:vm');

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
    puter: {
      enabled: false,
      providerId: 'puter',
      defaultModel: 'gpt-5-nano',
    },
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
        lastInput: null,
        async turn(input) {
          this.calls += 1;
          this.lastInput = input;
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

async function loadMarkdownHelpers() {
  const source = await readFile(join(__dirname, '..', 'src', 'web-ui', 'public', 'app.js'), 'utf-8');
  const context = { console, document: undefined };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.NativeOpenClawMarkdown;
}

async function loadWebUiClientHelpers(extraContext = {}) {
  const source = await readFile(join(__dirname, '..', 'src', 'web-ui', 'public', 'app.js'), 'utf-8');
  const context = { console, document: undefined, ...extraContext };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.SmoothWebUiClient;
}

test('Web UI Markdown renderer formats assistant content and escapes HTML', async () => {
  const helpers = await loadMarkdownHelpers();

  assert.match(helpers.renderMarkdown('Hello **Boss**'), /<strong>Boss<\/strong>/);
  assert.match(helpers.renderMarkdown('Use `npm run build`'), /<code>npm run build<\/code>/);
  assert.match(helpers.renderMarkdown('```js\nconsole.log("hello")\n```'), /<pre><code class="language-js">console\.log\(&quot;hello&quot;\)<\/code><\/pre>/);

  const malicious = helpers.renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(malicious, /<script>/i);
  assert.match(malicious, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('Web UI renders user messages as plain escaped text, not Markdown', async () => {
  const helpers = await loadMarkdownHelpers();
  const rendered = helpers.renderMessageContent('user', '**Boss**\n<script>alert(1)</script>');

  assert.doesNotMatch(rendered, /<strong>/);
  assert.match(rendered, /\*\*Boss\*\*/);
  assert.match(rendered, /<br>/);
  assert.doesNotMatch(rendered, /<script>/i);
});

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

test('Web UI serves favicon without authentication', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/favicon.ico`);
    const body = await response.arrayBuffer();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/x-icon');
    assert.ok(body.byteLength > 0);
  });
});

test('Web UI config endpoint is authenticated and hides secrets', async () => {
  await withServer(async (server) => {
    const unauthenticated = await fetch(`${server.url}/config`);
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const response = await fetch(`${server.url}/config`, {
      headers: { Cookie: cookieFrom(login) },
    });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    assert.equal(response.status, 200);
    assert.equal(body.appName, 'smooth');
    assert.equal(body.puter.enabled, false);
    assert.equal(body.puter.providerId, 'puter');
    assert.equal(body.puter.defaultModel, 'gpt-5-nano');
    assert.doesNotMatch(serialized, /secret|sessionSecret|password|API_KEY|TOKEN/i);
  });
});

test('Web UI config endpoint exposes safe Puter settings when enabled', async () => {
  await withServer(async (server) => {
    const login = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const response = await fetch(`${server.url}/config`, {
      headers: { Cookie: cookieFrom(login) },
    });
    const body = await response.json();

    assert.equal(body.puter.enabled, true);
    assert.equal(body.puter.providerId, 'puter');
    assert.equal(body.puter.defaultModel, 'gpt-5-nano');
    assert.equal(Object.hasOwn(body.puter, 'fallbackToBackend'), false);
    assert.equal(Object.hasOwn(body.puter, 'stream'), false);
    assert.equal(Object.hasOwn(body.puter, 'scriptUrl'), false);
  }, {
    puter: {
      enabled: true,
      providerId: 'puter',
      defaultModel: 'gpt-5-nano',
    },
  });
});

test('GET / without auth redirects to login', async () => {
  await withServer(async (server) => {
    const response = await fetch(`${server.url}/`, { redirect: 'manual' });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/login');
  });
});

test('Web UI pages use smooth as primary brand and Hazana as subtle support brand', async () => {
  await withServer(async (server) => {
    const oldBrand = ['Anth', 'eon AI'].join('');
    const oldLogo = ['anth', 'eon-logo'].join('');
    const login = await fetch(`${server.url}/login`);
    const loginHtml = await login.text();
    assert.match(loginHtml, /smooth/);
    assert.match(loginHtml, /Make your life easier/);
    assert.match(loginHtml, /Powered by Hazana Corp/);
    assert.match(loginHtml, /smooth-logo\.png/);
    assert.match(loginHtml, /smooth-icon\.png/);
    assert.doesNotMatch(loginHtml, new RegExp(oldBrand));
    assert.doesNotMatch(loginHtml, new RegExp(`${oldLogo}\\.png`));
    assert.doesNotMatch(loginHtml, /Hazana Corp Console/);

    const auth = await fetch(`${server.url}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'admin', password: 'secret' }),
      redirect: 'manual',
    });
    const chat = await fetch(`${server.url}/`, {
      headers: { Cookie: cookieFrom(auth) },
    });
    const chatHtml = await chat.text();
    assert.match(chatHtml, /smooth/);
    assert.match(chatHtml, /Make your life easier/);
    assert.match(chatHtml, /Ask smooth/);
    assert.match(chatHtml, /Powered by Hazana Corp/);
    assert.doesNotMatch(chatHtml, new RegExp(oldBrand));
    assert.doesNotMatch(chatHtml, new RegExp(`${oldLogo}\\.png`));
    assert.doesNotMatch(chatHtml, /Native OpenClaw \/ Jarpis/);
  });
});

test('Web UI client copy uses smooth loading and empty-state branding', async () => {
  const source = await readFile(join(__dirname, '..', 'src', 'web-ui', 'public', 'app.js'), 'utf-8');
  assert.match(source, /smooth is thinking/);
  assert.match(source, /Start a conversation with smooth/);
  assert.doesNotMatch(source, new RegExp(['Anth', 'eon AI'].join('')));
});

test('Web UI client does not expose direct Puter final-answer helpers', async () => {
  const source = await readFile(join(__dirname, '..', 'src', 'web-ui', 'public', 'app.js'), 'utf-8');
  const helpers = await loadWebUiClientHelpers();

  assert.equal(typeof helpers.sendMessageWithPuter, 'undefined');
  assert.doesNotMatch(source, /puter\.ai\.chat/);
});

test('Web UI chat payload includes preferred Puter provider only when enabled', async () => {
  const helpers = await loadWebUiClientHelpers();
  const config = helpers.normalizeWebConfig({
    puter: {
      enabled: true,
      providerId: 'puter',
      defaultModel: 'gpt-5-nano',
    },
  });
  const enabledPayload = helpers.buildChatPayload('halo', 'session-1', config);
  const disabledPayload = helpers.buildChatPayload('halo', null, helpers.createDefaultWebConfig());

  assert.deepEqual(JSON.parse(JSON.stringify(enabledPayload)), {
    message: 'halo',
    sessionId: 'session-1',
    source: 'web-ui',
    preferredProvider: 'puter',
    preferredModel: 'gpt-5-nano',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(disabledPayload)), { message: 'halo' });
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
    assert.equal(deps.orchestrator.lastInput.provider.id, 'fake');
    assert.equal(deps.orchestrator.lastInput.model, 'fake-model');
  });
});

test('POST /chat with Web UI Puter enabled routes through backend with preferred provider metadata', async () => {
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
    assert.equal(body.preferredProvider, 'fake');
    assert.equal(body.preferredModel, 'web-ui-model');
    assert.equal(body.provider, 'fake');
    assert.equal(body.model, 'fake-model');
    assert.equal(body.fallbackUsed, false);
    assert.equal(deps.orchestrator.calls, 1);
    assert.equal(deps.orchestrator.lastInput.provider.id, 'fake');
    assert.equal(deps.orchestrator.lastInput.model, 'web-ui-model');
  }, {
    puter: {
      enabled: true,
      providerId: 'fake',
      defaultModel: 'web-ui-model',
    },
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
