const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { runApiClient } = require('../dist/tools/api-client');

const originalFetch = global.fetch;
const originalEnv = {
  INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL,
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

function headers(map = { 'content-type': 'application/json' }) {
  return {
    get(name) {
      return map[String(name).toLowerCase()] ?? null;
    },
    forEach(callback) {
      for (const [key, value] of Object.entries(map)) callback(value, key);
    },
  };
}

function okJson(value) {
  return {
    ok: true,
    status: 200,
    headers: headers(),
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  };
}

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

test('runApiClient assembles URL from endpoint + port + path', async () => {
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return okJson({ ok: true });
  });

  await runApiClient({
    endpoint: 'http://localhost',
    port: 3000,
    path: '/api/users',
  });

  assert.equal(calledUrl, 'http://localhost:3000/api/users');
});

test('runApiClient uses full url field when provided (overrides endpoint+port+path)', async () => {
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return okJson({ ok: true });
  });

  await runApiClient({
    url: 'https://api.example.com/v1/test',
    endpoint: 'http://localhost',
    port: 3000,
    path: '/ignored',
    method: 'GET',
  });

  assert.equal(calledUrl, 'https://api.example.com/v1/test');
});

test('runApiClient sends POST with JSON body and Content-Type header', async () => {
  let capturedInit;
  mockFetch((_url, init) => {
    capturedInit = init;
    return okJson({ ok: true });
  });

  await runApiClient({
    url: 'http://localhost/api',
    method: 'POST',
    body: { key: 'value' },
  });

  assert.equal(capturedInit.method, 'POST');
  assert.equal(capturedInit.headers['Content-Type'], 'application/json');
  assert.equal(capturedInit.body, '{"key":"value"}');
});

test('runApiClient appends query params to URL', async () => {
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return okJson({ ok: true });
  });

  await runApiClient({
    url: 'http://localhost/api',
    params: { page: '1', limit: '10' },
  });

  const parsed = new URL(calledUrl);
  assert.equal(parsed.searchParams.get('page'), '1');
  assert.equal(parsed.searchParams.get('limit'), '10');
});

test('runApiClient substitutes pathParams in path', async () => {
  let calledUrl = '';
  mockFetch((url) => {
    calledUrl = url;
    return okJson({ ok: true });
  });

  await runApiClient({
    endpoint: 'http://localhost',
    path: '/api/{id}',
    pathParams: { id: '42' },
  });

  assert.equal(calledUrl, 'http://localhost/api/42');
});

test('runApiClient handles X-Api-Key header from array format', async () => {
  let capturedInit;
  mockFetch((_url, init) => {
    capturedInit = init;
    return okJson({ ok: true });
  });

  await runApiClient({
    url: 'http://localhost/api',
    headers: ['X-Api-Key: secret123'],
  });

  assert.equal(capturedInit.headers['X-Api-Key'], 'secret123');
});

test('runApiClient returns ok:false and content with error message on network failure', async () => {
  mockFetch(() => {
    throw new Error('connection refused');
  });

  const result = await runApiClient({ url: 'http://localhost/api' });

  assert.equal(result.ok, false);
  assert.match(result.content, /connection refused/);
});
