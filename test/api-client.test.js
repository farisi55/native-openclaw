const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { runApiClient } = require('../dist/tools/api-client');

const originalFetch = global.fetch;
const originalEnv = {
  INTERNAL_API_BASE_URL: process.env.INTERNAL_API_BASE_URL,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
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

async function withHttpServer(handler, fn) {
  const previousNoProxy = {
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';

  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
    if (previousNoProxy.NO_PROXY === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previousNoProxy.NO_PROXY;
    if (previousNoProxy.no_proxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousNoProxy.no_proxy;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
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

test('runApiClient returns timeout failure without unhandled rejection', async () => {
  await withHttpServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('slow');
    }, 100);
  }, async (baseUrl) => {
    const result = await runApiClient({ url: `${baseUrl}/slow`, timeout: 10 });

    assert.equal(result.ok, false);
    assert.match(result.content, /timed out|AbortError/i);
  });
});

test('runApiClient supports followRedirects=false without hitting target endpoint', async () => {
  let targetHits = 0;
  await withHttpServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/target' });
      res.end();
      return;
    }
    if (req.url === '/target') {
      targetHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('target');
      return;
    }
    res.writeHead(404);
    res.end();
  }, async (baseUrl) => {
    const result = await runApiClient({
      url: `${baseUrl}/redirect`,
      followRedirects: false,
    });

    assert.equal(result.status, 302);
    assert.equal(targetHits, 0);
  });
});

test('runApiClient handles headers as a single string', async () => {
  let receivedHeader = '';
  await withHttpServer((req, res) => {
    receivedHeader = req.headers['x-api-key'] ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const result = await runApiClient({
      url: `${baseUrl}/headers`,
      headers: 'X-Api-Key: abc123',
    });

    assert.equal(result.ok, true);
    assert.equal(receivedHeader, 'abc123');
  });
});

test('runApiClient handles params as a raw query string', async () => {
  let receivedUrl = '';
  await withHttpServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const result = await runApiClient({
      url: `${baseUrl}/query`,
      params: 'a=1&b=hello',
    });

    assert.equal(result.ok, true);
    const parsed = new URL(receivedUrl, baseUrl);
    assert.equal(parsed.searchParams.get('a'), '1');
    assert.equal(parsed.searchParams.get('b'), 'hello');
  });
});

test('runApiClient sends pre-serialized JSON string body without double encoding', async () => {
  let receivedBody = '';
  await withHttpServer(async (req, res) => {
    receivedBody = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, async (baseUrl) => {
    const result = await runApiClient({
      url: `${baseUrl}/body`,
      method: 'POST',
      headers: 'Content-Type: application/json',
      body: '{"hello":"world"}',
    });

    assert.equal(result.ok, true);
    assert.equal(receivedBody, '{"hello":"world"}');
  });
});

test('runApiClient returns ok:false and content with error message on network failure', async () => {
  mockFetch(() => {
    throw new Error('connection refused');
  });

  const result = await runApiClient({ url: 'http://localhost/api' });

  assert.equal(result.ok, false);
  assert.match(result.content, /connection refused/);
});
