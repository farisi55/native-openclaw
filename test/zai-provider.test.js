const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { createProviderRegistry, ZaiProvider } = require('../dist/providers');
const { createMessage } = require('../dist/types/message');

const originalFetch = global.fetch;
const originalEnv = {
  ZAI_API_KEY: process.env.ZAI_API_KEY,
  ZAI_BASE_URL: process.env.ZAI_BASE_URL,
  ZAI_MODEL: process.env.ZAI_MODEL,
  OLLAMA_ENABLED: process.env.OLLAMA_ENABLED,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function mockFetch(handler) {
  global.fetch = async (url, init) => handler(String(url), init);
}

function okJson(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return value;
    },
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

test('provider registry does not register zai without ZAI_API_KEY', async () => {
  delete process.env.ZAI_API_KEY;
  delete process.env.ZAI_BASE_URL;
  delete process.env.ZAI_MODEL;
  delete process.env.OLLAMA_ENABLED;

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('zai'), false);
});

test('provider registry registers zai when ZAI_API_KEY is set', async () => {
  process.env.ZAI_API_KEY = 'test-key';
  process.env.ZAI_BASE_URL = 'https://example.test/v4';
  process.env.ZAI_MODEL = 'glm-4.5';
  delete process.env.OLLAMA_ENABLED;

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('zai'), true);
  assert.equal(registry.get('zai').displayName, 'Z.ai');
});

test('zai listModels returns configured ZAI_MODEL and supports healthCheck', async () => {
  process.env.ZAI_API_KEY = 'test-key';
  process.env.ZAI_BASE_URL = 'https://example.test/v4';
  process.env.ZAI_MODEL = 'glm-4.5';

  mockFetch((url, init) => {
    assert.equal(url, 'https://example.test/v4/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    return okJson({ data: [{ id: 'glm-4.5', object: 'model' }] });
  });

  const provider = new ZaiProvider();
  const models = await provider.listModels();

  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'glm-4.5');
  assert.equal(models[0].supportsTools, true);
  assert.equal(await provider.healthCheck(), true);
});

test('zai listModels falls back to ZAI_MODEL if the models endpoint fails', async () => {
  process.env.ZAI_API_KEY = 'test-key';
  process.env.ZAI_BASE_URL = 'https://example.test/v4';
  process.env.ZAI_MODEL = 'glm-test';

  mockFetch(() => {
    throw new Error('network down');
  });

  const provider = new ZaiProvider();
  const models = await provider.listModels();

  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'glm-test');
});

test('zai chat uses OpenAI-compatible chat completions', async () => {
  process.env.ZAI_API_KEY = 'test-key';
  process.env.ZAI_BASE_URL = 'https://example.test/v4';
  process.env.ZAI_MODEL = 'glm-4.5';

  mockFetch((url, init) => {
    assert.equal(url, 'https://example.test/v4/chat/completions');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    assert.equal(init.headers['Content-Type'], 'application/json');

    const body = JSON.parse(init.body);
    assert.equal(body.model, 'glm-4.5');
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content, 'Be concise.');
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, 'hello');

    return okJson({
      model: 'glm-4.5',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    });
  });

  const provider = new ZaiProvider();
  const response = await provider.chat({
    model: 'glm-4.5',
    systemPrompt: 'Be concise.',
    temperature: 0.2,
    messages: [createMessage({ role: 'user', content: 'hello' })],
  });

  assert.equal(response.model, 'glm-4.5');
  assert.equal(response.message.role, 'assistant');
  assert.equal(response.message.content, 'hi');
  assert.equal(response.usage.totalTokens, 5);
});
