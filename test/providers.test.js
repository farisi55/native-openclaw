const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  GeminiProvider,
  GroqProvider,
  LlamaCppProvider,
  MistralProvider,
  OllamaProvider,
  OpenRouterProvider,
  SambaNovaProvider,
  PuterProvider,
} = require('../dist/providers');
const { createMessage } = require('../dist/types/message');
const { cmdModel, cmdProvider } = require('../dist/cli/commands');

const originalFetch = global.fetch;
const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GROQ_BASE_URL: process.env.GROQ_BASE_URL,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL,
  OLLAMA_ENABLED: process.env.OLLAMA_ENABLED,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  OLLAMA_DEFAULT_MODEL: process.env.OLLAMA_DEFAULT_MODEL,
  OLLAMA_MODELS: process.env.OLLAMA_MODELS,
  OLLAMA_TIMEOUT_MS: process.env.OLLAMA_TIMEOUT_MS,
  LLAMACPP_ENABLED: process.env.LLAMACPP_ENABLED,
  LLAMACPP_BASE_URL: process.env.LLAMACPP_BASE_URL,
  LLAMACPP_DEFAULT_MODEL: process.env.LLAMACPP_DEFAULT_MODEL,
  LLAMACPP_MODELS: process.env.LLAMACPP_MODELS,
  LLAMACPP_TIMEOUT_MS: process.env.LLAMACPP_TIMEOUT_MS,
  LLAMACPP_CTX_SIZE: process.env.LLAMACPP_CTX_SIZE,
  PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED: process.env.PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  OPENROUTER_SITE_NAME: process.env.OPENROUTER_SITE_NAME,
  OPENROUTER_SITE_URL: process.env.OPENROUTER_SITE_URL,
  SAMBANOVA_API_KEY: process.env.SAMBANOVA_API_KEY,
  SAMBANOVA_BASE_URL: process.env.SAMBANOVA_BASE_URL,
  PUTER_ENABLED: process.env.PUTER_ENABLED,
  PUTER_API_KEY: process.env.PUTER_API_KEY,
  PUTER_BASE_URL: process.env.PUTER_BASE_URL,
  PUTER_DEFAULT_MODEL: process.env.PUTER_DEFAULT_MODEL,
  PUTER_DISABLE_TEMPERATURE: process.env.PUTER_DISABLE_TEMPERATURE,
  PUTER_TEMPERATURE: process.env.PUTER_TEMPERATURE,
  PUTER_REASONING_MODELS_DISABLE_TEMPERATURE: process.env.PUTER_REASONING_MODELS_DISABLE_TEMPERATURE,
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
    async text() {
      return JSON.stringify(value);
    },
  };
}

function unauthorizedResponse() {
  return {
    ok: false,
    status: 401,
    async text() {
      return 'unauthorized';
    },
  };
}

function openAiChatResponse(content) {
  return okJson({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    model: 'test-model',
    id: 'test-id',
  });
}

function badRequestText(value) {
  return {
    ok: false,
    status: 400,
    async text() {
      return value;
    },
  };
}

function chatOptions() {
  return {
    model: 'test-model',
    systemPrompt: 'Be concise.',
    messages: [createMessage({ role: 'user', content: 'hello' })],
  };
}

function setPuterEnv(overrides = {}) {
  process.env.PUTER_API_KEY = 'test-key-xxx';
  process.env.PUTER_BASE_URL = 'https://puter.example.test/v1';
  process.env.PUTER_DEFAULT_MODEL = 'gpt-5.5';
  delete process.env.PUTER_DISABLE_TEMPERATURE;
  delete process.env.PUTER_TEMPERATURE;
  delete process.env.PUTER_REASONING_MODELS_DISABLE_TEMPERATURE;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
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

const openAiProviders = [
  {
    name: 'Groq',
    Provider: GroqProvider,
    keyEnv: 'GROQ_API_KEY',
    baseEnv: 'GROQ_BASE_URL',
    baseUrl: 'https://groq.example.test/v1',
    auth: 'Authorization',
  },
  {
    name: 'Mistral',
    Provider: MistralProvider,
    keyEnv: 'MISTRAL_API_KEY',
    baseEnv: 'MISTRAL_BASE_URL',
    baseUrl: 'https://mistral.example.test/v1',
    auth: 'Authorization',
  },
  {
    name: 'SambaNova',
    Provider: SambaNovaProvider,
    keyEnv: 'SAMBANOVA_API_KEY',
    baseEnv: 'SAMBANOVA_BASE_URL',
    baseUrl: 'https://sambanova.example.test/v1',
    auth: 'Authorization',
  },
  {
    name: 'OpenRouter',
    Provider: OpenRouterProvider,
    keyEnv: 'OPENROUTER_API_KEY',
    baseEnv: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.example.test/api/v1',
    auth: 'Authorization',
  },
  {
    name: 'Puter',
    Provider: PuterProvider,
    keyEnv: 'PUTER_API_KEY',
    baseEnv: 'PUTER_BASE_URL',
    baseUrl: 'https://puter.example.test/v1',
    auth: 'Authorization',
  },
];

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

for (const spec of openAiProviders) {
  test(`${spec.name} chat() sends correct Authorization header`, async () => {
    process.env[spec.keyEnv] = 'test-key-xxx';
    process.env[spec.baseEnv] = spec.baseUrl;

    mockFetch((_url, init) => {
      assert.equal(init.headers[spec.auth], 'Bearer test-key-xxx');
      return openAiChatResponse('hello world');
    });

    const provider = new spec.Provider();
    await provider.chat(chatOptions());
  });

  test(`${spec.name} chat() parses assistant message from response`, async () => {
    process.env[spec.keyEnv] = 'test-key-xxx';
    process.env[spec.baseEnv] = spec.baseUrl;

    mockFetch(() => openAiChatResponse('hello world'));

    const provider = new spec.Provider();
    const response = await provider.chat(chatOptions());

    assert.equal(response.message.content, 'hello world');
  });

  test(`${spec.name} listModels() falls back gracefully when API returns 401`, async () => {
    process.env[spec.keyEnv] = 'test-key-xxx';
    process.env[spec.baseEnv] = spec.baseUrl;

    mockFetch(() => unauthorizedResponse());

    const provider = new spec.Provider();
    const models = await provider.listModels();

    assert.ok(Array.isArray(models));
  });
}

test('Puter omits global default temperature for gpt-5.5', async () => {
  setPuterEnv();
  let requestBody = null;
  mockFetch((_url, init) => {
    requestBody = JSON.parse(init.body);
    return openAiChatResponse('hello world');
  });

  const provider = new PuterProvider();
  await provider.chat({
    ...chatOptions(),
    model: 'gpt-5.5',
    temperature: 0.7,
  });

  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
});

test('Puter omits temperature for any model when PUTER_DISABLE_TEMPERATURE=true', async () => {
  setPuterEnv({ PUTER_DISABLE_TEMPERATURE: 'true', PUTER_TEMPERATURE: '0.2' });
  let requestBody = null;
  mockFetch((_url, init) => {
    requestBody = JSON.parse(init.body);
    return openAiChatResponse('hello world');
  });

  const provider = new PuterProvider();
  await provider.chat({
    ...chatOptions(),
    model: 'some-compatible-model',
    temperature: 0.7,
  });

  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
});

test('Puter sends configured temperature only when enabled and model supports it', async () => {
  setPuterEnv({ PUTER_DISABLE_TEMPERATURE: 'false', PUTER_TEMPERATURE: '0.2' });
  let requestBody = null;
  mockFetch((_url, init) => {
    requestBody = JSON.parse(init.body);
    return openAiChatResponse('hello world');
  });

  const provider = new PuterProvider();
  await provider.chat({
    ...chatOptions(),
    model: 'some-compatible-model',
    temperature: 0.7,
  });

  assert.equal(requestBody.temperature, 0.2);
});

test('Puter omits temperature for gpt-5 models even when temperature is configured', async () => {
  setPuterEnv({ PUTER_DISABLE_TEMPERATURE: 'false', PUTER_TEMPERATURE: '0.2' });
  let requestBody = null;
  mockFetch((_url, init) => {
    requestBody = JSON.parse(init.body);
    return openAiChatResponse('hello world');
  });

  const provider = new PuterProvider();
  await provider.chat({
    ...chatOptions(),
    model: 'gpt-5-mini',
    temperature: 0.7,
  });

  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
});

test('Puter retries once without temperature when the provider rejects temperature', async () => {
  setPuterEnv({ PUTER_DISABLE_TEMPERATURE: 'false', PUTER_TEMPERATURE: '0.2' });
  const bodies = [];
  mockFetch((_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return badRequestText('{ "error": "400 Unsupported value: \'temperature\' does not support 0.2 with this model" }');
    }
    return openAiChatResponse('retry ok');
  });

  const provider = new PuterProvider();
  const response = await provider.chat({
    ...chatOptions(),
    model: 'some-compatible-model',
  });

  assert.equal(response.message.content, 'retry ok');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0.2);
  assert.equal(Object.hasOwn(bodies[1], 'temperature'), false);
});

test('Puter throws when retry without temperature also fails', async () => {
  setPuterEnv({ PUTER_DISABLE_TEMPERATURE: 'false', PUTER_TEMPERATURE: '0.2' });
  let calls = 0;
  mockFetch(() => {
    calls += 1;
    return badRequestText('{ "error": "400 Unsupported value: \'temperature\' does not support this model" }');
  });

  const provider = new PuterProvider();
  await assert.rejects(
    () => provider.chat({
      ...chatOptions(),
      model: 'some-compatible-model',
    }),
    /Unsupported value/
  );
  assert.equal(calls, 2);
});

test('Gemini chat() sends correct API key query parameter', async () => {
  process.env.GEMINI_API_KEY = 'test-key-xxx';
  process.env.GEMINI_BASE_URL = 'https://gemini.example.test/v1beta';

  mockFetch((url, init) => {
    assert.equal(url, 'https://gemini.example.test/v1beta/models/test-model:generateContent?key=test-key-xxx');
    assert.equal(init.headers['Content-Type'], 'application/json');
    return okJson({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello world' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      modelVersion: 'test-model',
    });
  });

  const provider = new GeminiProvider();
  await provider.chat(chatOptions());
});

test('Gemini chat() parses assistant message from response', async () => {
  process.env.GEMINI_API_KEY = 'test-key-xxx';
  process.env.GEMINI_BASE_URL = 'https://gemini.example.test/v1beta';

  mockFetch(() => okJson({
    candidates: [{ content: { role: 'model', parts: [{ text: 'hello world' }] } }],
  }));

  const provider = new GeminiProvider();
  const response = await provider.chat(chatOptions());

  assert.equal(response.message.content, 'hello world');
});

test('Gemini listModels() falls back gracefully when API returns 401', async () => {
  process.env.GEMINI_API_KEY = 'test-key-xxx';
  process.env.GEMINI_BASE_URL = 'https://gemini.example.test/v1beta';

  mockFetch(() => unauthorizedResponse());

  const provider = new GeminiProvider();
  const models = await provider.listModels();

  assert.ok(Array.isArray(models));
});

test('Ollama chat() sends request to configured base URL', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  let calledUrl = '';

  mockFetch((url) => {
    calledUrl = url;
    return okJson({
      model: 'llama-test',
      message: { role: 'assistant', content: 'hello world' },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    });
  });

  const provider = new OllamaProvider();
  const response = await provider.chat({
    model: 'llama-test',
    messages: [createMessage({ role: 'user', content: 'hello' })],
  });

  assert.equal(calledUrl, 'http://localhost:11434/api/chat');
  assert.equal(response.message.content, 'hello world');
});

test('Ollama chat() uses qwen2.5 default model when no model is provided', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  delete process.env.OLLAMA_DEFAULT_MODEL;
  delete process.env.OLLAMA_MODELS;
  let body;

  mockFetch((_url, init) => {
    body = JSON.parse(init.body);
    return okJson({
      model: body.model,
      message: { role: 'assistant', content: 'hello world' },
      done: true,
    });
  });

  const provider = new OllamaProvider();
  await provider.chat({
    messages: [createMessage({ role: 'user', content: 'hello' })],
  });

  assert.equal(body.model, 'qwen2.5:0.5b');
});

test('Ollama chat() falls back from Docker hostname to local host endpoint', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
  process.env.OLLAMA_DEFAULT_MODEL = 'qwen2.5:0.5b';
  const calledUrls = [];

  mockFetch((url) => {
    calledUrls.push(url);
    if (url.startsWith('http://ollama:11434')) {
      throw new Error('getaddrinfo ENOTFOUND ollama');
    }
    return okJson({
      model: 'qwen2.5:0.5b',
      message: { role: 'assistant', content: 'local ok' },
      done: true,
    });
  });

  const provider = new OllamaProvider();
  const response = await provider.chat({
    model: 'qwen2.5:0.5b',
    messages: [createMessage({ role: 'user', content: 'hai' })],
  });

  assert.deepEqual(calledUrls, [
    'http://ollama:11434/api/chat',
    'http://localhost:11434/api/chat',
  ]);
  assert.equal(response.message.content, 'local ok');
});

test('Ollama listModels() falls back from Docker hostname to local installed models', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
  process.env.OLLAMA_DEFAULT_MODEL = 'qwen2.5:0.5b';
  const calledUrls = [];

  mockFetch((url) => {
    calledUrls.push(url);
    if (url.startsWith('http://ollama:11434')) {
      throw new Error('getaddrinfo ENOTFOUND ollama');
    }
    return okJson({
      models: [
        { name: 'qwen3.6', model: 'qwen3.6' },
        { name: 'llama3.2', model: 'llama3.2' },
      ],
    });
  });

  const provider = new OllamaProvider();
  const models = await provider.listModels();

  assert.deepEqual(calledUrls, [
    'http://ollama:11434/api/tags',
    'http://localhost:11434/api/tags',
  ]);
  assert.ok(models.some((model) => model.id === 'qwen3.6'));
  assert.ok(models.some((model) => model.id === 'llama3.2'));
  assert.ok(models.some((model) => model.id === 'qwen2.5:0.5b'));
});

test('Ollama listModels() falls back to configured model when server is unreachable', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  process.env.OLLAMA_DEFAULT_MODEL = 'qwen2.5:0.5b';

  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });

  const provider = new OllamaProvider();
  const models = await provider.listModels();

  assert.equal(models[0].id, 'qwen2.5:0.5b');
});

test('Ollama listModels includes configured default model with qwen2.5 smoke default', async () => {
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  delete process.env.OLLAMA_DEFAULT_MODEL;
  delete process.env.OLLAMA_MODELS;

  mockFetch(() => okJson({ models: [] }));

  const provider = new OllamaProvider();
  const models = await provider.listModels();

  assert.ok(models.some((model) => model.id === 'qwen2.5:0.5b'));
});

test('/model falls back to active provider list when registry hides untested local models', async () => {
  process.env.PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED = 'false';
  const provider = {
    id: 'ollama',
    displayName: 'Ollama (local)',
    async listModels() {
      return [
        { id: 'qwen2.5:0.5b', name: 'qwen2.5:0.5b' },
        { id: 'llama3.2', name: 'llama3.2' },
      ];
    },
    async chat() {
      throw new Error('not used');
    },
  };

  const output = await captureStdout(() =>
    cmdModel({
      activeProvider: provider,
      activeModel: 'qwen2.5:0.5b',
      providers: new Map([['ollama', provider]]),
    }, [])
  );

  assert.match(output, /qwen2\.5:0\.5b/);
  assert.match(output, /llama3\.2/);
  assert.doesNotMatch(output, /No models found/);
});

test('Ollama provider doctor reports disabled, unavailable, missing model, and OK states', async () => {
  process.env.OLLAMA_ENABLED = 'false';
  let output = await captureStdout(() => cmdProvider({ providers: new Map() }, ['doctor', 'ollama']));
  assert.match(output, /Ollama disabled/);

  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  process.env.OLLAMA_DEFAULT_MODEL = 'qwen2.5:0.5b';
  let provider = new OllamaProvider();

  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['ollama', provider]]) }, ['doctor', 'ollama'])
  );
  assert.match(output, /Ollama server unavailable at http:\/\/localhost:11434/);

  mockFetch((url) => {
    assert.match(url, /\/api\/tags$/);
    return okJson({ models: [{ name: 'llama3.2:1b' }] });
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['ollama', provider]]) }, ['doctor', 'ollama'])
  );
  assert.match(output, /Model qwen2\.5:0\.5b not found/);

  provider = new OllamaProvider();
  mockFetch((url) => {
    if (url.endsWith('/api/tags')) {
      return okJson({ models: [{ name: 'qwen2.5:0.5b' }] });
    }
    assert.match(url, /\/api\/chat$/);
    return okJson({
      model: 'qwen2.5:0.5b',
      message: { role: 'assistant', content: 'OK' },
      done: true,
    });
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['ollama', provider]]) }, ['doctor', 'ollama'])
  );
  assert.match(output, /Ollama OK/);
});

test('llama.cpp provider doctor reports disabled, unavailable, missing model, and OK states', async () => {
  process.env.LLAMACPP_ENABLED = 'false';
  let output = await captureStdout(() => cmdProvider({ providers: new Map() }, ['doctor', 'llamacpp']));
  assert.match(output, /llama\.cpp provider disabled/);
  assert.match(output, /docker compose --profile llamacpp up -d/);

  process.env.LLAMACPP_ENABLED = 'true';
  process.env.LLAMACPP_BASE_URL = 'http://llama-cpp:8091';
  process.env.LLAMACPP_DEFAULT_MODEL = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
  process.env.LLAMACPP_MODELS = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
  let provider = new LlamaCppProvider();

  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['llamacpp', provider]]) }, ['doctor', 'llamacpp'])
  );
  assert.match(output, /llama\.cpp server unavailable at http:\/\/llama-cpp:8091/);
  assert.match(output, /docker compose --profile llamacpp up -d/);

  mockFetch((url) => {
    assert.match(url, /\/v1\/models$/);
    return okJson({ data: [{ id: 'other-model.gguf' }] });
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['llamacpp', provider]]) }, ['doctor', 'llamacpp'])
  );
  assert.match(output, /Model qwen2\.5-0\.5b-instruct-q4_k_m\.gguf not found/);
  assert.match(output, /docker compose logs llama-cpp/);

  provider = new LlamaCppProvider();
  mockFetch((url) => {
    if (url.endsWith('/v1/models')) {
      return okJson({ data: [{ id: 'qwen2.5-0.5b-instruct-q4_k_m.gguf' }] });
    }
    assert.match(url, /\/v1\/chat\/completions$/);
    return openAiChatResponse('OK');
  });
  output = await captureStdout(() =>
    cmdProvider({ providers: new Map([['llamacpp', provider]]) }, ['doctor', 'llamacpp'])
  );
  assert.match(output, /llama\.cpp OK at/);
  assert.match(output, /qwen2\.5-0\.5b-instruct-q4_k_m\.gguf/);
});
