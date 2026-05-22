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
  'OLLAMA_BASE_URL',
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

test('validateConfig does NOT throw when OLLAMA_BASE_URL is set', () => {
  withProviderEnv({ OLLAMA_BASE_URL: 'http://localhost:11434' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});

test('validateConfig does NOT throw when OPENAI_API_KEY is set', () => {
  withProviderEnv({ OPENAI_API_KEY: 'test-openai-key' }, () => {
    assert.doesNotThrow(() => validateConfig());
  });
});
