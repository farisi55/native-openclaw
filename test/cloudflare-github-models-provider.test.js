const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  CloudflareProvider,
  CerebrasProvider,
  CohereProvider,
  GitHubModelsProvider,
  HuggingFaceProvider,
  LlamaCppProvider,
  NvidiaProvider,
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
  'HUGGINGFACE_ENABLED',
  'HUGGINGFACE_API_KEY',
  'HUGGINGFACE_BASE_URL',
  'HUGGINGFACE_DEFAULT_MODEL',
  'HUGGINGFACE_MODELS',
  'HUGGINGFACE_TIMEOUT_MS',
  'HF_API_KEY',
  'HF_TOKEN',
  'COHERE_ENABLED',
  'COHERE_API_KEY',
  'COHERE_BASE_URL',
  'COHERE_DEFAULT_MODEL',
  'COHERE_MODELS',
  'COHERE_TIMEOUT_MS',
  'CEREBRAS_ENABLED',
  'CEREBRAS_API_KEY',
  'CEREBRAS_BASE_URL',
  'CEREBRAS_DEFAULT_MODEL',
  'CEREBRAS_MODELS',
  'CEREBRAS_TIMEOUT_MS',
  'NVIDIA_ENABLED',
  'NVIDIA_API_KEY',
  'NVIDIA_BASE_URL',
  'NVIDIA_DEFAULT_MODEL',
  'NVIDIA_MODELS',
  'NVIDIA_TIMEOUT_MS',
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
  'OLLAMA_ENABLED',
  'OLLAMA_BASE_URL',
  'OLLAMA_DEFAULT_MODEL',
  'OLLAMA_MODELS',
  'OLLAMA_TIMEOUT_MS',
  'LLAMACPP_ENABLED',
  'LLAMACPP_BASE_URL',
  'LLAMACPP_DEFAULT_MODEL',
  'LLAMACPP_MODELS',
  'LLAMACPP_TIMEOUT_MS',
  'LLAMACPP_CTX_SIZE',
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

function huggingfaceEnv(overrides = {}) {
  process.env.HUGGINGFACE_ENABLED = 'true';
  process.env.HUGGINGFACE_API_KEY = 'hf-test-key';
  process.env.HUGGINGFACE_DEFAULT_MODEL = 'openai/gpt-oss-120b:fastest';
  process.env.HUGGINGFACE_MODELS = 'openai/gpt-oss-120b:fastest';
  process.env.HUGGINGFACE_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function cohereEnv(overrides = {}) {
  process.env.COHERE_ENABLED = 'true';
  process.env.COHERE_API_KEY = 'cohere-test-key';
  process.env.COHERE_DEFAULT_MODEL = 'command-a-plus-05-2026';
  process.env.COHERE_MODELS = 'command-a-plus-05-2026';
  process.env.COHERE_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function cerebrasEnv(overrides = {}) {
  process.env.CEREBRAS_ENABLED = 'true';
  process.env.CEREBRAS_API_KEY = 'cerebras-test-key';
  process.env.CEREBRAS_DEFAULT_MODEL = 'gemma-4-31b';
  process.env.CEREBRAS_MODELS = 'gemma-4-31b';
  process.env.CEREBRAS_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function nvidiaEnv(overrides = {}) {
  process.env.NVIDIA_ENABLED = 'true';
  process.env.NVIDIA_API_KEY = 'nvidia-test-key';
  process.env.NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
  process.env.NVIDIA_MODELS = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
  process.env.NVIDIA_TIMEOUT_MS = '120000';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
}

function llamaCppEnv(overrides = {}) {
  process.env.LLAMACPP_ENABLED = 'true';
  process.env.LLAMACPP_BASE_URL = 'http://llama-cpp:8091';
  process.env.LLAMACPP_DEFAULT_MODEL = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
  process.env.LLAMACPP_MODELS = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
  process.env.LLAMACPP_TIMEOUT_MS = '120000';
  process.env.LLAMACPP_CTX_SIZE = '8192';
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
  process.env.HUGGINGFACE_ENABLED = 'false';
  process.env.COHERE_ENABLED = 'false';
  process.env.CEREBRAS_ENABLED = 'false';
  process.env.NVIDIA_ENABLED = 'false';
  process.env.OLLAMA_ENABLED = 'false';
  process.env.LLAMACPP_ENABLED = 'false';

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('cloudflare'), false);
  assert.equal(registry.has('github-models'), false);
  assert.equal(registry.has('huggingface'), false);
  assert.equal(registry.has('cohere'), false);
  assert.equal(registry.has('cerebras'), false);
  assert.equal(registry.has('nvidia'), false);
  assert.equal(registry.has('ollama'), false);
  assert.equal(registry.has('llamacpp'), false);
});

test('Ollama registers only when OLLAMA_ENABLED=true', async () => {
  clearProviderEnv();
  process.env.OLLAMA_ENABLED = 'true';
  process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
  process.env.OLLAMA_DEFAULT_MODEL = 'qwen2.5:0.5b';

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('ollama'), true);
  assert.equal(registry.get('ollama').displayName, 'Ollama (local)');
});

test('llama.cpp registers only when LLAMACPP_ENABLED=true', async () => {
  clearProviderEnv();
  llamaCppEnv();

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('llamacpp'), true);
  assert.equal(registry.get('llamacpp').displayName, 'llama.cpp Server');
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

test('Hugging Face enabled config accepts token aliases in priority order', async () => {
  clearProviderEnv();
  process.env.HUGGINGFACE_ENABLED = 'true';
  assert.throws(() => validateConfig(), /HUGGINGFACE_API_KEY or HF_API_KEY or HF_TOKEN/);

  process.env.HF_TOKEN = 'hf-token-key';
  assert.doesNotThrow(() => validateConfig());

  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('hf token ok');
  });
  await new HuggingFaceProvider().chat(options('openai/gpt-oss-120b:fastest'));
  assert.equal(request.init.headers.Authorization, 'Bearer hf-token-key');

  process.env.HF_API_KEY = 'hf-api-key';
  await new HuggingFaceProvider().chat(options('openai/gpt-oss-120b:fastest'));
  assert.equal(request.init.headers.Authorization, 'Bearer hf-api-key');

  process.env.HUGGINGFACE_API_KEY = 'hf-primary-key';
  await new HuggingFaceProvider().chat(options('openai/gpt-oss-120b:fastest'));
  assert.equal(request.init.headers.Authorization, 'Bearer hf-primary-key');
});

test('Cohere enabled config requires API key', () => {
  clearProviderEnv();
  process.env.COHERE_ENABLED = 'true';
  assert.throws(() => validateConfig(), /COHERE_API_KEY/);

  process.env.COHERE_API_KEY = 'cohere-test-key';
  assert.doesNotThrow(() => validateConfig());
});

test('Cerebras and NVIDIA enabled config require API keys', () => {
  clearProviderEnv();
  process.env.CEREBRAS_ENABLED = 'true';
  assert.throws(() => validateConfig(), /CEREBRAS_API_KEY/);

  process.env.CEREBRAS_API_KEY = 'cerebras-test-key';
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  process.env.NVIDIA_ENABLED = 'true';
  assert.throws(() => validateConfig(), /NVIDIA_API_KEY/);

  process.env.NVIDIA_API_KEY = 'nvidia-test-key';
  assert.doesNotThrow(() => validateConfig());
});

test('provider timeout config must be positive', () => {
  clearProviderEnv();
  cloudflareEnv({ CLOUDFLARE_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /CLOUDFLARE_TIMEOUT_MS must be a positive integer/);

  clearProviderEnv();
  huggingfaceEnv({ HUGGINGFACE_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /HUGGINGFACE_TIMEOUT_MS must be a positive integer/);

  clearProviderEnv();
  cohereEnv({ COHERE_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /COHERE_TIMEOUT_MS must be a positive integer/);

  clearProviderEnv();
  cerebrasEnv({ CEREBRAS_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /CEREBRAS_TIMEOUT_MS must be a positive integer/);

  clearProviderEnv();
  nvidiaEnv({ NVIDIA_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /NVIDIA_TIMEOUT_MS must be a positive integer/);

  clearProviderEnv();
  llamaCppEnv({ LLAMACPP_TIMEOUT_MS: '0' });
  assert.throws(() => validateConfig(), /LLAMACPP_TIMEOUT_MS must be a positive integer/);
});

test('Cloudflare, GitHub Models, Hugging Face, Cohere, Cerebras, NVIDIA, and llama.cpp satisfy provider validation', () => {
  clearProviderEnv();
  cloudflareEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  githubEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  huggingfaceEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  cohereEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  cerebrasEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  nvidiaEnv();
  assert.doesNotThrow(() => validateConfig());

  clearProviderEnv();
  llamaCppEnv();
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

test('Hugging Face builds router endpoint, headers, and OpenAI-compatible body', async () => {
  clearProviderEnv();
  huggingfaceEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('huggingface ok');
  });

  const provider = new HuggingFaceProvider();
  const result = await provider.chat(options('openai/gpt-oss-120b:fastest'));
  const body = JSON.parse(request.init.body);

  assert.equal(request.url, 'https://router.huggingface.co/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer hf-test-key');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'openai/gpt-oss-120b:fastest');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'Hello');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'huggingface ok');
});

test('Cohere builds compatibility endpoint, headers, and OpenAI-compatible body', async () => {
  clearProviderEnv();
  cohereEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('cohere ok');
  });

  const provider = new CohereProvider();
  const result = await provider.chat(options('command-a-plus-05-2026'));
  const body = JSON.parse(request.init.body);

  assert.equal(request.url, 'https://api.cohere.ai/compatibility/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer cohere-test-key');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'command-a-plus-05-2026');
  assert.equal(body.messages[1].content, 'Hello');
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'cohere ok');
});

test('Cerebras builds chat endpoint and maps maxTokens to max_completion_tokens', async () => {
  clearProviderEnv();
  cerebrasEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('cerebras ok');
  });

  const provider = new CerebrasProvider();
  const result = await provider.chat({
    ...options('gemma-4-31b'),
    maxTokens: 1024,
    extra: {
      top_p: 1,
      stream: true,
      reasoning_effort: 'medium',
    },
  });
  const body = JSON.parse(request.init.body);

  assert.equal(request.url, 'https://api.cerebras.ai/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer cerebras-test-key');
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(body.model, 'gemma-4-31b');
  assert.equal(body.max_completion_tokens, 1024);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.top_p, 1);
  assert.equal(body.reasoning_effort, 'medium');
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'cerebras ok');
});

test('NVIDIA NIM builds chat endpoint and maps reasoning options', async () => {
  clearProviderEnv();
  nvidiaEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('nvidia ok');
  });

  const provider = new NvidiaProvider();
  const result = await provider.chat({
    ...options('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'),
    temperature: 0.6,
    maxTokens: 65536,
    extra: {
      top_p: 0.95,
      stream: true,
      reasoning_budget: 16384,
      enable_thinking: true,
    },
  });
  const body = JSON.parse(request.init.body);

  assert.equal(request.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer nvidia-test-key');
  assert.equal(request.init.headers.Accept, 'application/json');
  assert.equal(body.model, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning');
  assert.equal(body.temperature, 0.6);
  assert.equal(body.top_p, 0.95);
  assert.equal(body.max_tokens, 65536);
  assert.equal(body.reasoning_budget, 16384);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'nvidia ok');
});

test('llama.cpp builds OpenAI-compatible endpoint without Authorization header', async () => {
  clearProviderEnv();
  llamaCppEnv();
  let request;
  mockFetch((url, init) => {
    request = { url, init };
    return chatResponse('llamacpp ok');
  });

  const provider = new LlamaCppProvider();
  const result = await provider.chat(options('qwen2.5-0.5b-instruct-q4_k_m.gguf'));
  const body = JSON.parse(request.init.body);

  assert.equal(request.url, 'http://llama-cpp:8091/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(body.model, 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].content, 'Hello');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 64);
  assert.equal(body.stream, false);
  assert.equal(result.message.content, 'llamacpp ok');
});

test('llama.cpp discovers /v1/models and keeps configured fallback model', async () => {
  clearProviderEnv();
  llamaCppEnv({ LLAMACPP_MODELS: 'qwen2.5-0.5b-instruct-q4_k_m.gguf,custom.gguf' });
  mockFetch((url) => {
    assert.equal(url, 'http://llama-cpp:8091/v1/models');
    return response(200, { data: [{ id: 'served.gguf' }] });
  });

  const models = await new LlamaCppProvider().listModels();

  assert.deepEqual(
    models.map((model) => model.id),
    ['served.gguf', 'qwen2.5-0.5b-instruct-q4_k_m.gguf', 'custom.gguf']
  );
});

test('llama.cpp listModels falls back to configured model when server is unreachable', async () => {
  clearProviderEnv();
  llamaCppEnv();
  mockFetch(() => {
    throw new Error('ECONNREFUSED');
  });

  const models = await new LlamaCppProvider().listModels();

  assert.equal(models[0].id, 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
});

test('Hugging Face, Cohere, Cerebras, and NVIDIA list configured models', async () => {
  clearProviderEnv();
  huggingfaceEnv({
    HUGGINGFACE_MODELS: 'openai/gpt-oss-120b:fastest,meta-llama/llama-test',
  });
  assert.deepEqual(
    (await new HuggingFaceProvider().listModels()).map((model) => model.id),
    ['openai/gpt-oss-120b:fastest', 'meta-llama/llama-test']
  );

  clearProviderEnv();
  cohereEnv({ COHERE_MODELS: 'command-a-plus-05-2026,command-r-plus' });
  assert.deepEqual(
    (await new CohereProvider().listModels()).map((model) => model.id),
    ['command-a-plus-05-2026', 'command-r-plus']
  );

  clearProviderEnv();
  cerebrasEnv({ CEREBRAS_MODELS: 'gemma-4-31b,custom-cerebras-model' });
  mockFetch(() => {
    throw new Error('models unavailable');
  });
  assert.deepEqual(
    (await new CerebrasProvider().listModels()).map((model) => model.id),
    ['gemma-4-31b', 'custom-cerebras-model']
  );

  clearProviderEnv();
  nvidiaEnv({ NVIDIA_MODELS: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,custom-nvidia-model' });
  mockFetch(() => {
    throw new Error('models unavailable');
  });
  assert.deepEqual(
    (await new NvidiaProvider().listModels()).map((model) => model.id),
    ['nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'custom-nvidia-model']
  );
});

for (const spec of [
  {
    name: 'Cloudflare',
    setup: () => cloudflareEnv(),
    create: () => new CloudflareProvider(),
    model: '@cf/meta/llama-3.1-8b-instruct',
    timeoutKey: 'CLOUDFLARE_TIMEOUT_MS',
    authMessage: /Cloudflare Workers AI authentication failed/,
    rateMessage: /Cloudflare Workers AI rate limit exceeded/,
  },
  {
    name: 'GitHub Models',
    setup: () => githubEnv(),
    create: () => new GitHubModelsProvider(),
    model: 'openai/gpt-4.1',
    timeoutKey: 'GITHUB_MODELS_TIMEOUT_MS',
    authMessage: /GitHub Models authentication failed/,
    rateMessage: /GitHub Models rate limit exceeded/,
  },
  {
    name: 'Hugging Face',
    setup: () => huggingfaceEnv(),
    create: () => new HuggingFaceProvider(),
    model: 'openai/gpt-oss-120b:fastest',
    timeoutKey: 'HUGGINGFACE_TIMEOUT_MS',
    authMessage: /Hugging Face authentication failed/,
    rateMessage: /Hugging Face rate limit exceeded/,
  },
  {
    name: 'Cohere',
    setup: () => cohereEnv(),
    create: () => new CohereProvider(),
    model: 'command-a-plus-05-2026',
    timeoutKey: 'COHERE_TIMEOUT_MS',
    authMessage: /Cohere authentication failed/,
    rateMessage: /Cohere rate limit exceeded/,
  },
  {
    name: 'Cerebras',
    setup: () => cerebrasEnv(),
    create: () => new CerebrasProvider(),
    model: 'gemma-4-31b',
    timeoutKey: 'CEREBRAS_TIMEOUT_MS',
    authMessage: /Cerebras authentication failed/,
    rateMessage: /Cerebras rate limit exceeded/,
  },
  {
    name: 'NVIDIA NIM',
    setup: () => nvidiaEnv(),
    create: () => new NvidiaProvider(),
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    timeoutKey: 'NVIDIA_TIMEOUT_MS',
    authMessage: /NVIDIA NIM authentication failed/,
    rateMessage: /NVIDIA NIM rate limit exceeded/,
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
    process.env[spec.timeoutKey] = '5';
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

test('enabled Cloudflare, GitHub Models, Hugging Face, Cohere, Cerebras, NVIDIA, and llama.cpp providers register', async () => {
  clearProviderEnv();
  cloudflareEnv();
  githubEnv();
  huggingfaceEnv();
  cohereEnv();
  cerebrasEnv();
  nvidiaEnv();
  llamaCppEnv();

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('cloudflare'), true);
  assert.equal(registry.has('github-models'), true);
  assert.equal(registry.has('huggingface'), true);
  assert.equal(registry.has('cohere'), true);
  assert.equal(registry.has('cerebras'), true);
  assert.equal(registry.has('nvidia'), true);
  assert.equal(registry.has('llamacpp'), true);
});

test('Cerebras and NVIDIA auto-register when API keys are present and enabled flags are unset', async () => {
  clearProviderEnv();
  process.env.CEREBRAS_API_KEY = 'cerebras-test-key';
  process.env.NVIDIA_API_KEY = 'nvidia-test-key';

  const registry = await createProviderRegistry({});

  assert.equal(registry.has('cerebras'), true);
  assert.equal(registry.has('nvidia'), true);
});

test('hyphenated provider ID resolves GITHUB_MODELS_DEFAULT_MODEL', () => {
  clearProviderEnv();
  process.env.GITHUB_MODELS_DEFAULT_MODEL = 'openai/gpt-test';
  assert.equal(
    providerDefaultModelFromEnv('github-models'),
    'openai/gpt-test'
  );
});

test('provider default model env resolves Hugging Face, Cohere, Cerebras, and NVIDIA', () => {
  clearProviderEnv();
  process.env.HUGGINGFACE_DEFAULT_MODEL = 'hf/model';
  process.env.COHERE_DEFAULT_MODEL = 'cohere-model';
  process.env.CEREBRAS_DEFAULT_MODEL = 'cerebras-model';
  process.env.NVIDIA_DEFAULT_MODEL = 'nvidia-model';

  assert.equal(providerDefaultModelFromEnv('huggingface'), 'hf/model');
  assert.equal(providerDefaultModelFromEnv('cohere'), 'cohere-model');
  assert.equal(providerDefaultModelFromEnv('cerebras'), 'cerebras-model');
  assert.equal(providerDefaultModelFromEnv('nvidia'), 'nvidia-model');
});

test('provider default model env resolves llama.cpp', () => {
  clearProviderEnv();
  process.env.LLAMACPP_DEFAULT_MODEL = 'local-model.gguf';

  assert.equal(providerDefaultModelFromEnv('llamacpp'), 'local-model.gguf');
});

test('PROVIDER_ORDER is parsed and de-duplicated', () => {
  process.env.PROVIDER_ORDER = 'huggingface, cohere, huggingface, groq';
  assert.deepEqual(
    configuredProviderOrder(),
    ['huggingface', 'cohere', 'groq']
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

test('router falls back from Hugging Face to Cohere on retryable error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-provider-router-'));
  process.env.PROVIDER_ORDER = 'huggingface,cohere';
  try {
    const huggingface = routerProvider('huggingface', 'rate-limit');
    const cohere = routerProvider('cohere', 'ok');
    const router = new ProviderRouter(
      new Map([
        ['huggingface', huggingface],
        ['cohere', cohere],
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

    const result = await router.chat(huggingface, 'hf-model', {
      model: 'hf-model',
      messages: [],
    });

    assert.equal(result.providerId, 'cohere');
    assert.equal(result.usedFallback, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('router falls back from Cohere to the next configured provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-provider-router-'));
  process.env.PROVIDER_ORDER = 'cohere,openrouter';
  try {
    const cohere = routerProvider('cohere', 'rate-limit');
    const openrouter = routerProvider('openrouter', 'ok');
    const router = new ProviderRouter(
      new Map([
        ['cohere', cohere],
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

    const result = await router.chat(cohere, 'cohere-model', {
      model: 'cohere-model',
      messages: [],
    });

    assert.equal(result.providerId, 'openrouter');
    assert.equal(result.usedFallback, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
