const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  ModelCacheService,
  ProviderModelDiscoveryService,
  GitHubModelsDiscoveryAdapter,
  CohereDiscoveryAdapter,
  HuggingFaceDiscoveryAdapter,
  CloudflareDiscoveryAdapter,
} = require('../dist/providers/discovery');
const { cmdModels } = require('../dist/cli/commands');
const { createMessage } = require('../dist/types/message');

const originalFetch = global.fetch;
const ENV_KEYS = [
  'PROVIDER_MODEL_DISCOVERY_ENABLED',
  'PROVIDER_MODEL_DISCOVERY_CACHE_PATH',
  'PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS',
  'PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER',
  'PROVIDER_MODEL_DISCOVERY_CHAT_ONLY',
  'PROVIDER_MODEL_DISCOVERY_TOOLS_ONLY',
  'PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED',
  'GITHUB_MODELS_API_KEY',
  'GITHUB_MODELS_API_VERSION',
  'COHERE_API_KEY',
  'COHERE_BASE_URL',
  'HUGGINGFACE_API_KEY',
  'HF_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_DISCOVERY_ENABLED',
  'HUGGINGFACE_DISCOVERY_PROVIDERS',
  'HUGGINGFACE_DISCOVERY_PIPELINE_TAGS',
  'HUGGINGFACE_DISCOVERY_LIMIT_PER_PROVIDER',
  'CLOUDFLARE_DISCOVERY_ENABLED',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PROVIDER_MODEL_DISCOVERY_ENABLED = 'true';
  process.env.PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = '30000';
  process.env.PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER = '200';
  process.env.PROVIDER_MODEL_DISCOVERY_CHAT_ONLY = 'true';
  process.env.PROVIDER_MODEL_DISCOVERY_TOOLS_ONLY = 'false';
  process.env.PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED = 'true';
}

test.after(() => {
  restoreEnv();
  global.fetch = originalFetch;
});

test.beforeEach(() => {
  clearEnv();
  global.fetch = originalFetch;
});

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function mockFetch(handler) {
  global.fetch = async (url, init) => handler(String(url), init);
}

async function withTempCache(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-model-cache-'));
  process.env.PROVIDER_MODEL_DISCOVERY_CACHE_PATH = join(dir, 'provider-model-cache.json');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeProvider(id, models = []) {
  return {
    id,
    displayName: id,
    async listModels() {
      return models.map((model) => ({
        id: model,
        name: model,
        contextWindow: 8192,
        supportsTools: false,
        supportsVision: false,
      }));
    },
    async chat(options) {
      return {
        message: createMessage({ role: 'assistant', content: 'OK' }),
        model: options.model,
        latencyMs: 1,
      };
    },
  };
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) callback();
    return true;
  });
  try {
    await fn();
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('model cache reads missing cache safely and handles corrupt cache', async () => {
  await withTempCache(async () => {
    const cache = new ModelCacheService();
    const missing = await cache.read();
    assert.equal(missing.version, 1);
    assert.deepEqual(missing.providers, {});

    await writeFile(cache.filePath, '{broken json', 'utf8');
    const corrupt = await cache.read();
    assert.equal(corrupt.version, 1);
    assert.deepEqual(corrupt.custom, {});
  });
});

test('model cache preserves custom models when refresh writes discovered models', async () => {
  await withTempCache(async () => {
    const cache = new ModelCacheService();
    await cache.addCustomModel('huggingface', 'custom/model:fireworks-ai');
    await cache.setDiscoveredModels('huggingface', [{
      id: 'discovered/model:groq',
      providerId: 'huggingface',
      source: 'discovered',
    }]);

    const merged = await cache.providerModels(fakeProvider('huggingface'), [{
      id: 'configured/model',
      name: 'configured/model',
      contextWindow: 1000,
      supportsTools: true,
      supportsVision: false,
    }]);
    assert.ok(merged.some((model) => model.id === 'custom/model:fireworks-ai' && model.source === 'custom'));
    assert.ok(merged.some((model) => model.id === 'configured/model' && model.source === 'configured'));
    assert.ok(merged.some((model) => model.id === 'discovered/model:groq' && model.source === 'discovered'));
  });
});

test('GitHub Models discovery calls catalog endpoint and normalizes chat models', async () => {
  process.env.GITHUB_MODELS_API_KEY = 'github-token';
  process.env.GITHUB_MODELS_API_VERSION = '2026-03-10';
  let requestedUrl = '';
  let headers;
  mockFetch((url, init) => {
    requestedUrl = url;
    headers = init.headers;
    return response(200, [
      { id: 'openai/gpt-4.1', display_name: 'GPT-4.1', input_modalities: ['text'], output_modalities: ['text'] },
      { id: 'embedding-model', output_modalities: ['embedding'] },
    ]);
  });

  const models = await new GitHubModelsDiscoveryAdapter().refresh();
  assert.equal(requestedUrl, 'https://models.github.ai/catalog/models');
  assert.equal(headers.Authorization, 'Bearer github-token');
  assert.equal(headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.deepEqual(models.map((model) => model.id), ['openai/gpt-4.1']);
  assert.equal(models[0].source, 'discovered');
});

test('Cohere discovery uses /v1/models pagination and endpoint filter', async () => {
  process.env.COHERE_API_KEY = 'cohere-token';
  process.env.COHERE_BASE_URL = 'https://api.cohere.ai/compatibility/v1';
  const urls = [];
  mockFetch((url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer cohere-token');
    if (urls.length === 1) {
      return response(200, {
        models: [{ name: 'command-a', endpoints: ['chat'], features: ['chat-completions'], context_length: 256000 }],
        next_page_token: 'next-page',
      });
    }
    return response(200, {
      models: [{ name: 'embed-v4', endpoints: ['embed'], features: ['embedding'] }],
    });
  });

  const models = await new CohereDiscoveryAdapter().refresh();
  assert.match(urls[0], /^https:\/\/api\.cohere\.ai\/v1\/models\?/);
  assert.match(urls[0], /endpoint=chat/);
  assert.match(urls[1], /page_token=next-page/);
  assert.deepEqual(models.map((model) => model.id), ['command-a']);
});

test('Hugging Face discovery uses inference_provider and router model-id format', async () => {
  process.env.HUGGINGFACE_API_KEY = 'hf-token';
  process.env.HUGGINGFACE_DISCOVERY_PROVIDERS = 'fireworks-ai';
  process.env.HUGGINGFACE_DISCOVERY_PIPELINE_TAGS = 'text-generation';
  process.env.HUGGINGFACE_DISCOVERY_LIMIT_PER_PROVIDER = '10';
  let requestedUrl = '';
  mockFetch((url, init) => {
    requestedUrl = url;
    assert.equal(init.headers.Authorization, 'Bearer hf-token');
    return response(200, [
      { id: 'deepseek-ai/DeepSeek-V3', pipeline_tag: 'text-generation', tags: ['text-generation'] },
    ]);
  });

  const models = await new HuggingFaceDiscoveryAdapter().refresh();
  assert.match(requestedUrl, /inference_provider=fireworks-ai/);
  assert.match(requestedUrl, /pipeline_tag=text-generation/);
  assert.deepEqual(models.map((model) => model.id), ['deepseek-ai/DeepSeek-V3:fireworks-ai']);
});

test('Cloudflare discovery handles missing credentials and invalid catalog responses', async () => {
  let adapter = new CloudflareDiscoveryAdapter();
  assert.equal(adapter.isEnabled(), false);
  assert.equal(
    adapter.disabledReason(),
    'Cloudflare remote model discovery is disabled. Using configured and curated models.'
  );

  process.env.CLOUDFLARE_DISCOVERY_ENABLED = 'true';
  adapter = new CloudflareDiscoveryAdapter();
  assert.equal(adapter.isEnabled(), false);
  assert.equal(adapter.disabledReason(), 'Missing CLOUDFLARE_API_KEY.');

  process.env.CLOUDFLARE_API_KEY = 'cf-token';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'account-123';
  adapter = new CloudflareDiscoveryAdapter();
  mockFetch((url, init) => {
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account-123/ai/models');
    assert.equal(init.headers.Authorization, 'Bearer cf-token');
    return response(200, { success: true, result: { notModels: [] } });
  });

  await assert.rejects(() => adapter.refresh(), /invalid response/);
});

test('Cloudflare discovery is skipped by default instead of failing startup refresh', async () => {
  await withTempCache(async () => {
    process.env.CLOUDFLARE_API_KEY = 'cf-token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-123';
    const providers = new Map([
      ['cloudflare', fakeProvider('cloudflare', ['@cf/meta/llama-3.1-8b-instruct'])],
    ]);
    const service = new ProviderModelDiscoveryService(
      providers,
      new ModelCacheService(),
      [new CloudflareDiscoveryAdapter()]
    );

    const results = await service.refresh();
    assert.equal(results.length, 1);
    assert.equal(results[0].providerId, 'cloudflare');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].skipped, true);
    assert.equal(results[0].error.code, 'DISCOVERY_UNSUPPORTED');
  });
});

test('discovery service refresh failure for one provider does not block another', async () => {
  await withTempCache(async () => {
    const adapters = [
      {
        providerId: 'bad',
        isEnabled: () => true,
        async refresh() {
          throw new Error('boom');
        },
      },
      {
        providerId: 'good',
        isEnabled: () => true,
        async refresh() {
          return [{ id: 'good-model', providerId: 'good', source: 'discovered' }];
        },
      },
    ];
    const providers = new Map([
      ['bad', fakeProvider('bad')],
      ['good', fakeProvider('good')],
    ]);
    const service = new ProviderModelDiscoveryService(providers, new ModelCacheService(), adapters);
    const results = await service.refresh();
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
    const models = await service.listProvider('good');
    assert.ok(models.some((model) => model.id === 'good-model'));
  });
});

test('discovery service refreshes registered providers without dedicated adapters via listModels', async () => {
  await withTempCache(async () => {
    const providers = new Map([
      ['groq', fakeProvider('groq', ['llama-3.3-70b-versatile'])],
      ['ollama', fakeProvider('ollama', ['qwen2.5:1.5b'])],
    ]);
    const service = new ProviderModelDiscoveryService(providers, new ModelCacheService(), []);

    const results = await service.refresh();
    assert.equal(results.length, 2);
    assert.equal(results.find((result) => result.providerId === 'groq').ok, true);
    assert.equal(results.find((result) => result.providerId === 'ollama').ok, true);

    const groqRefresh = results.find((result) => result.providerId === 'groq');
    const ollamaRefresh = results.find((result) => result.providerId === 'ollama');
    assert.ok(groqRefresh.models.some((model) =>
      model.id === 'llama-3.3-70b-versatile' && model.source === 'discovered'
    ));
    assert.ok(ollamaRefresh.models.some((model) =>
      model.id === 'qwen2.5:1.5b' && model.source === 'discovered'
    ));
  });
});

test('dedicated discovery adapters take precedence over generic listModels refresh', async () => {
  await withTempCache(async () => {
    let genericListCalled = 0;
    const provider = fakeProvider('huggingface', ['configured/hf-model']);
    provider.listModels = async () => {
      genericListCalled++;
      return [{ id: 'configured/hf-model', name: 'configured/hf-model', contextWindow: 8192, supportsTools: false, supportsVision: false }];
    };
    const providers = new Map([['huggingface', provider]]);
    const adapters = [{
      providerId: 'huggingface',
      isEnabled: () => true,
      async refresh() {
        return [{ id: 'adapter/hf-model', providerId: 'huggingface', source: 'discovered' }];
      },
    }];
    const service = new ProviderModelDiscoveryService(providers, new ModelCacheService(), adapters);

    const results = await service.refresh();
    assert.equal(results.length, 1);
    assert.equal(results[0].providerId, 'huggingface');
    assert.equal(genericListCalled, 0);
    const models = await service.listProvider('huggingface');
    assert.ok(models.some((model) => model.id === 'adapter/hf-model'));
  });
});

test('provider model test updates status tested-ok and tested-failed', async () => {
  await withTempCache(async () => {
    const provider = fakeProvider('huggingface');
    const providers = new Map([['huggingface', provider]]);
    const service = new ProviderModelDiscoveryService(providers, new ModelCacheService(), []);
    await service.addCustomModel('huggingface', 'custom-ok');
    const ok = await service.testModel('huggingface', 'custom-ok');
    assert.equal(ok.ok, true);
    let listed = await service.listProvider('huggingface');
    assert.equal(listed.find((model) => model.id === 'custom-ok').status, 'tested-ok');

    provider.chat = async () => {
      throw new Error('model failed');
    };
    await service.addCustomModel('huggingface', 'custom-fail');
    const fail = await service.testModel('huggingface', 'custom-fail');
    assert.equal(fail.ok, false);
    listed = await service.listProvider('huggingface');
    assert.equal(listed.find((model) => model.id === 'custom-fail').status, 'tested-failed');
  });
});

test('/models displays configured, curated, discovered, and custom models from unified registry', async () => {
  await withTempCache(async () => {
    const providers = new Map([
      ['huggingface', fakeProvider('huggingface', ['configured/model'])],
    ]);
    const service = new ProviderModelDiscoveryService(providers, new ModelCacheService(), []);
    await service.addCustomModel('huggingface', 'custom/model:groq');
    await new ModelCacheService().setDiscoveredModels('huggingface', [{
      id: 'discovered/model:fireworks-ai',
      providerId: 'huggingface',
      source: 'discovered',
    }]);
    const ctx = {
      providers,
      activeProvider: providers.get('huggingface'),
      activeModel: 'configured/model',
      skillRegistry: { activeIds: [], all: () => [], size: 0 },
      sessions: {},
      settings: {},
      toolRegistry: {},
      activeSessionId: null,
      setProvider() {},
      setModel() {},
      async setSession() {},
    };

    const output = await captureStdout(() => cmdModels(ctx, ['huggingface']));
    assert.match(output, /configured\/model/);
    assert.match(output, /custom\/model:groq/);
    assert.match(output, /discovered\/model:fireworks-ai/);
    assert.match(output, /openai\/gpt-oss-120b:fastest/);
  });
});
