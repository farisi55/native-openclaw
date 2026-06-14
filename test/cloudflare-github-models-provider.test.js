const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  CloudflareProvider,
  GitHubModelsProvider,
  createProviderRegistry,
  providerDefaultModelFromEnv,
} = require('../dist/providers');
const { validateConfig } = require('../dist/config/validator');
const { createMessage } = require('../dist/types/message');
const { ProviderError } = require('../dist/types/provider');
const { ProviderRouter } = require('../dist/router/provider-router');
const { configuredProviderOrder } = require('../dist/router/routing-strategy');

const originalFetch = global.fetch;
const ENV_KEYS = [
  'CLOUDFLARE_AI_ENABLED',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_BASE_URL',
  'CLOUDFLARE_DEFAULT_MODEL',
  'CLOUDFLARE_MODELS',
  'CLOUDFLARE_TIMEOUT_MS',
  'GITHUB_MODELS_ENABLED',
  'GITHUB_MODELS_API_KEY',
  'GITHUB_MODELS_BASE_URL',
  'GITHUB_MODELS_DEFAULT_MODEL',
  'GITHUB_MODELS_MODELS',
  'GITHUB_MODELS_API_VERSION',
  'GITHUB_MODELS_ORG',
  'GITHUB_MODELS_USE_ORG_ENDPOINT',
  'GITHUB_MODELS_TIMEOUT_MS',
  'PROVIDER_ORDER',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'ZAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'SAMBANOVA_API_KEY',
  'PUTER_ENABLED',
  'PUTER_API_KEY',
  'OLLAMA_BASE_URL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearProviderEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function cloudflareEnv(overrides = {}) {
  process.env.CLOUDFLARE_AI_ENABLED = 'true';
  process.env.CLOUDFLARE_API_KEY = 'cf-test-key';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-123';
  process.env.CLOUDFLARE_DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
  process.env.CLOUDFLARE_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function githubEnv(overrides = {}) {
  process.env.GITHUB_MODELS_ENABLED = 'true';
  process.env.GITHUB_MODELS_API_KEY = 'github-test-key';
  process.env.GITHUB_MODELS_DEFAULT_MODEL = 'openai/gpt-4.1';
  process.env.GITHUB_MODELS_API_VERSION = '2026-03-10';
  process.env.GITHUB_MODELS_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function mockFetch(handler) {
  global.fetch = async (url, init) => handler(String(url), init);
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (typeof body === 'string') return JSON.parse(body);
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function chatResponse(content = 'OK') {
  return response(200, {
    model: 'served-model',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function options(model) {
  return {
    model,
    systemPrompt: 'Be concise.',
    temperature: 0.2,
    maxTokens: 64,
    messages: [createMessage({ role: 'user', content: 'Hello' })],
  };
}

function timeoutFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (init.signal.aborted) abort();
    else init.signal.addEventListener('abort', abort, { once: true });
  });
}

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

test('disabled providers are not registered', async () => {
  clearProviderEnv();
  process.env.CLOUDFLARE_AI_ENABLED = 'false';
  process.env.GITHUB_MODELS_ENABLED = 'false';

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('cloudflare'), false);
  assert.equal(registry.has('github-models'), false);
});

test('Cloudflare enabled config requires API key and account ID', () => {
  clearProviderEnv();
  process.env.CLOUDFLARE_AI_ENABLED = 'true';
  assert.throws(() => validateConfig(), /CLOUDFLARE_API_KEY/);

  process.env.CLOUDFLARE_API_KEY = 'cf-test-key';
  assert.throws(() => validateConfig(), /CLOUDFLARE_ACCOUNT_ID/);
});

test('GitHub Models enabled config requires API key and org for org endpoint', () => {
  clearProviderEnv();
  process.env.GITHUB_MODELS_ENABLED = 'true';
  assert.throws(() => validateConfig(), /GITHUB_MODELS_API_KEY/);

  process.env.GITHUB_MODELS_API_KEY = 'github-test-key';
  process.env.GITHUB_MODELS_USE_ORG_ENDPOINT = 'true';
  assert.throws(() => validateConfig(), /GITHUB_MODELS_ORG/);
});

test('provider timeout config must be positive', () => {
  clearProviderEnv();
  cloudflareEnv({ CLOUDFLARE_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /CLOUDFLARE_TIMEOUT_MS must be a positive integer/);
});

test('Cloudflare and GitHub Models each satisfy provider validation when correctly configured', () => {
  clearProviderEnv();
  cloudflareEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  githubEnv();
  assert.doesNotThrow(() => validateConfig());
});

test('Cloudflare builds account endpoint, headers, and OpenAI-compatible body', async () => {
  clearProviderEnv();
  cloudflareEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('cloudflare ok');
  });

  const provider = new CloudflareProvider();
  const result = await provider.chat(options('@cf/meta/llama-3.1-8b-instruct'));
  const body = JSON.parse(request.init.body);

  assert.equal(
    request.url,
    'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions'
  );
  assert.equal(request.init.headers.Authorization, 'Bearer cf-test-key');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, '@cf/meta/llama-3.1-8b-instruct');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'Hello');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'cloudflare ok');
});

test('Cloudflare expands account placeholder and parses configured models safely', async () => {
  clearProviderEnv();
  cloudflareEnv({
    CLOUDFLARE_BASE_URL:
      'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/',
    CLOUDFLARE_MODELS:
      '@cf/openai/gpt-oss-120b, @cf/meta/llama-3.1-8b-instruct, @cf/openai/gpt-oss-120b',
  });
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return chatResponse();
  });

  const provider = new CloudflareProvider();
  const models = await provider.listModels();
  await provider.chat(options(models[0].id));

  assert.equal(models.length, 2);
  assert.equal(models[0].id, '@cf/meta/llama-3.1-8b-instruct');
  assert.match(calledUrl, /accounts\/account-123\/ai\/v1\/chat\/completions$/);
});

test('Cloudflare normalizes account-root URLs and native ai/run model paths', async () => {
  clearProviderEnv();
  cloudflareEnv({
    CLOUDFLARE_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts',
    CLOUDFLARE_DEFAULT_MODEL: 'ai/run/@cf/moonshotai/kimi-k2.7-code',
    CLOUDFLARE_MODELS:
      'ai/run/@cf/moonshotai/kimi-k2.7-code,@cf/meta/llama-3.1-8b-instruct',
  });
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('normalized');
  });

  const provider = new CloudflareProvider();
  const models = await provider.listModels();
  await provider.chat(options('ai/run/@cf/moonshotai/kimi-k2.7-code'));
  const body = JSON.parse(request.init.body);

  assert.equal(
    request.url,
    'https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1/chat/completions'
  );
  assert.equal(body.model, '@cf/moonshotai/kimi-k2.7-code');
  assert.equal(models[0].id, '@cf/moonshotai/kimi-k2.7-code');
  assert.equal(models.some((model) => model.id.startsWith('ai/run/')), false);
});

test('GitHub Models uses default endpoint and required GitHub headers', async () => {
  clearProviderEnv();
  githubEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('github ok');
  });

  const provider = new GitHubModelsProvider();
  const result = await provider.chat(options('openai/gpt-4.1'));
  const body = JSON.parse(request.init.body);

  assert.equal(
    request.url,
    'https://models.github.ai/inference/chat/completions'
  );
  assert.equal(request.init.headers.Authorization, 'Bearer github-test-key');
  assert.equal(request.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(request.init.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'openai/gpt-4.1');
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'github ok');
});

test('GitHub Models supports organization endpoint', async () => {
  clearProviderEnv();
  githubEnv({
    GITHUB_MODELS_USE_ORG_ENDPOINT: 'true',
    GITHUB_MODELS_ORG: 'hazana corp',
  });
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return chatResponse();
  });

  const provider = new GitHubModelsProvider();
  await provider.chat(options('openai/gpt-4.1'));

  assert.equal(
    calledUrl,
    'https://models.github.ai/orgs/hazana%20corp/inference/chat/completions'
  );
});

for (const spec of [
  {
    name: 'Cloudflare',
    setup: () => cloudflareEnv(),
    create: () => new CloudflareProvider(),
    model: '@cf/meta/llama-3.1-8b-instruct',
    authMessage: /Cloudflare Workers AI authentication failed/,
    rateMessage: /Cloudflare Workers AI rate limit exceeded/,
  },
  {
    name: 'GitHub Models',
    setup: () => githubEnv(),
    create: () => new GitHubModelsProvider(),
    model: 'openai/gpt-4.1',
    authMessage: /GitHub Models authentication failed/,
    rateMessage: /GitHub Models rate limit exceeded/,
  },
]) {
  test(`${spec.name} normalizes auth errors`, async () => {
    clearProviderEnv();
    spec.setup();
    mockFetch(() => response(401, { error: { message: 'secret provider detail' } }));

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      (error) => {
        assert.equal(error.code, 'UNAUTHORIZED');
        assert.match(error.message, spec.authMessage);
        assert.doesNotMatch(error.message, /secret provider detail/);
        return true;
      }
    );
  });

  test(`${spec.name} normalizes rate limits as retryable`, async () => {
    clearProviderEnv();
    spec.setup();
    mockFetch(() => response(429, { error: { message: 'limited' } }));

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      (error) => {
        assert.equal(error.code, 'RATE_LIMITED');
        assert.equal(error.isRetryable(), true);
        assert.match(error.message, spec.rateMessage);
        return true;
      }
    );
  });

  test(`${spec.name} normalizes request-too-large errors`, async () => {
    clearProviderEnv();
    spec.setup();
    mockFetch(() => response(413, { error: { message: 'payload too large' } }));

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      (error) => {
        assert.equal(error.code, 'CONTEXT_EXCEEDED');
        assert.equal(error.isRetryable(), false);
        return true;
      }
    );
  });

  test(`${spec.name} rejects empty choices`, async () => {
    clearProviderEnv();
    spec.setup();
    mockFetch(() => response(200, { choices: [] }));

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      /API returned no choices/
    );
  });

  test(`${spec.name} normalizes invalid JSON responses`, async () => {
    clearProviderEnv();
    spec.setup();
    mockFetch(() => response(200, 'not-json'));

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      (error) => {
        assert.equal(error.code, 'NETWORK_ERROR');
        return true;
      }
    );
  });

  test(`${spec.name} maps timeout to ProviderError TIMEOUT`, async () => {
    clearProviderEnv();
    spec.setup();
    if (spec.name === 'Cloudflare') process.env.CLOUDFLARE_TIMEOUT_MS = '5';
    else process.env.GITHUB_MODELS_TIMEOUT_MS = '5';
    mockFetch(timeoutFetch);

    await assert.rejects(
      () => spec.create().chat(options(spec.model)),
      (error) => {
        assert.equal(error.code, 'TIMEOUT');
        assert.equal(error.isRetryable(), true);
        return true;
      }
    );
  });
}

test('enabled Cloudflare and GitHub Models providers register in ProviderRouter registry', async () => {
  clearProviderEnv();
  cloudflareEnv();
  githubEnv();

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('cloudflare'), true);
  assert.equal(registry.has('github-models'), true);
});

test('hyphenated provider ID resolves GITHUB_MODELS_DEFAULT_MODEL', () => {
  clearProviderEnv();
  process.env.GITHUB_MODELS_DEFAULT_MODEL = 'openai/gpt-test';
  assert.equal(
    providerDefaultModelFromEnv('github-models'),
    'openai/gpt-test'
  );
});

test('PROVIDER_ORDER is parsed and de-duplicated', () => {
  process.env.PROVIDER_ORDER = 'github-models, cloudflare, github-models, groq';
  assert.deepEqual(
    configuredProviderOrder(),
    ['github-models', 'cloudflare', 'groq']
  );
});

function routerProvider(id, behavior) {
  let calls = 0;
  return {
    id,
    displayName: id,
    get calls() {
      return calls;
    },
    async listModels() {
      return [{ id: `${id}-model` }];
    },
    async chat() {
      calls += 1;
      if (behavior === 'rate-limit') {
        throw new ProviderError(id, 'RATE_LIMITED', `${id} limited`);
      }
      if (behavior === 'context-exceeded') {
        throw new ProviderError(id, 'CONTEXT_EXCEEDED', `${id} request too large`);
      }
      return {
        message: createMessage({ role: 'assistant', content: `${id} ok` }),
        model: `${id}-model`,
        latencyMs: 1,
      };
    },
  };
}

test('router falls back from Cloudflare to GitHub Models on retryable error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-provider-router-'));
  process.env.PROVIDER_ORDER = 'cloudflare,github-models';
  try {
    const cloudflare = routerProvider('cloudflare', 'rate-limit');
    const github = routerProvider('github-models', 'ok');
    const router = new ProviderRouter(
      new Map([
        ['cloudflare', cloudflare],
        ['github-models', github],
      ]),
      {
        enabled: true,
        autoFallback: true,
        autoSwitch: false,
        maxAttempts: 2,
        dataDir: dir,
      }
    );
    await router.init();

    const result = await router.chat(cloudflare, 'cloudflare-model', {
      model: 'cloudflare-model',
      messages: [],
    });

    assert.equal(result.providerId, 'github-models');
    assert.equal(result.usedFallback, true);
    assert.equal(cloudflare.calls, 1);
    assert.equal(github.calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('router may fall back after Cloudflare rejects an oversized request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-provider-router-'));
  process.env.PROVIDER_ORDER = 'cloudflare,github-models';
  try {
    const cloudflare = routerProvider('cloudflare', 'context-exceeded');
    const github = routerProvider('github-models', 'ok');
    const router = new ProviderRouter(
      new Map([
        ['cloudflare', cloudflare],
        ['github-models', github],
      ]),
      {
        enabled: true,
        autoFallback: true,
        autoSwitch: false,
        maxAttempts: 2,
        dataDir: dir,
      }
    );
    await router.init();

    const result = await router.chat(cloudflare, 'cloudflare-model', {
      model: 'cloudflare-model',
      messages: [],
    });

    assert.equal(result.providerId, 'github-models');
    assert.equal(result.usedFallback, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('router falls back from GitHub Models to the next configured provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-provider-router-'));
  process.env.PROVIDER_ORDER = 'github-models,openrouter';
  try {
    const github = routerProvider('github-models', 'rate-limit');
    const openrouter = routerProvider('openrouter', 'ok');
    const router = new ProviderRouter(
      new Map([
        ['github-models', github],
        ['openrouter', openrouter],
      ]),
      {
        enabled: true,
        autoFallback: true,
        autoSwitch: false,
        maxAttempts: 2,
        dataDir: dir,
      }
    );
    await router.init();

    const result = await router.chat(github, 'github-model', {
      model: 'github-model',
      messages: [],
    });

    assert.equal(result.providerId, 'openrouter');
    assert.equal(result.usedFallback, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
