const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { validateConfig } = require('../dist/config/validator');

const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'ZAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'PUTER_API_KEY',
  'OLLAMA_ENABLED',
  'OLLAMA_BASE_URL',
  'OLLAMA_DEFAULT_MODEL',
  'OLLAMA_TIMEOUT_MS',
  'LLAMACPP_ENABLED',
  'LLAMACPP_BASE_URL',
  'LLAMACPP_DEFAULT_MODEL',
  'LLAMACPP_TIMEOUT_MS',
  'CLOUDFLARE_AI_ENABLED',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_TIMEOUT_MS',
  'CLOUDFLARE_DISCOVERY_ENABLED',
  'GITHUB_MODELS_ENABLED',
  'GITHUB_MODELS_API_KEY',
  'GITHUB_MODELS_USE_ORG_ENDPOINT',
  'GITHUB_MODELS_ORG',
  'GITHUB_MODELS_TIMEOUT_MS',
  'HUGGINGFACE_ENABLED',
  'HUGGINGFACE_API_KEY',
  'HF_API_KEY',
  'HF_TOKEN',
  'HUGGINGFACE_TIMEOUT_MS',
  'COHERE_ENABLED',
  'COHERE_API_KEY',
  'COHERE_TIMEOUT_MS',
  'PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS',
  'PROVIDER_MODEL_DISCOVERY_CACHE_TTL_HOURS',
  'PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER',
  'HUGGINGFACE_DISCOVERY_LIMIT_PER_PROVIDER',
];

function withProviderEnv(overrides, fn) {
  const snapshot = {};
  for (const key of PROVIDER_ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of PROVIDER_ENV_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  }
}

test('validateConfig throws when no provider keys are set', () => {
  withProviderEnv({}, () => {
    assert.throws(() => validateConfig(), /No provider API keys/);
  });
});

test('validateConfig does NOT throw when OLLAMA_ENABLED=true', () => {
  withProviderEnv({ OLLAMA_ENABLED: 'true', OLLAMA_BASE_URL: 'http://localhost:11434' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});

test('validateConfig does NOT throw when LLAMACPP_ENABLED=true', () => {
  withProviderEnv({ LLAMACPP_ENABLED: 'true', LLAMACPP_BASE_URL: 'http://llama-cpp:8091' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});

test('validateConfig validates Ollama URL and timeout when enabled', () => {
  withProviderEnv({ OLLAMA_ENABLED: 'true', OLLAMA_BASE_URL: 'not-a-url' }, () => {
    assert.throws(() => validateConfig(), /OLLAMA_BASE_URL/);
  });
  withProviderEnv({ OLLAMA_ENABLED: 'true', OLLAMA_TIMEOUT_MS: '0' }, () => {
    assert.throws(() => validateConfig(), /OLLAMA_TIMEOUT_MS/);
  });
});

test('validateConfig validates llama.cpp URL and timeout when enabled', () => {
  withProviderEnv({ LLAMACPP_ENABLED: 'true', LLAMACPP_BASE_URL: 'not-a-url' }, () => {
    assert.throws(() => validateConfig(), /LLAMACPP_BASE_URL/);
  });
  withProviderEnv({ LLAMACPP_ENABLED: 'true', LLAMACPP_TIMEOUT_MS: '0' }, () => {
    assert.throws(() => validateConfig(), /LLAMACPP_TIMEOUT_MS/);
  });
});

test('validateConfig does NOT throw when OPENAI_API_KEY is set', () => {
  withProviderEnv({ OPENAI_API_KEY: 'test-openai-key' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});

test('validateConfig does NOT throw when PUTER_API_KEY is set', () => {
  withProviderEnv({ PUTER_API_KEY: 'test-puter-key' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});
