const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { browse } = require('../dist/tools/browsing');

const originalFetch = global.fetch;
const originalEnv = {
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
  BROWSING_TIMEOUT_MS: process.env.BROWSING_TIMEOUT_MS,
  BROWSING_MAX_RESULTS: process.env.BROWSING_MAX_RESULTS,
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

function errorResponse(status) {
  return {
    ok: false,
    status,
    async text() {
      return `HTTP ${status}`;
    },
  };
}

function tavilyResponse() {
  return okJson({
    results: [
      {
        title: 'Tavily Result',
        url: 'https://example.com/tavily',
        content: 'Tavily search snippet',
        score: 0.9,
      },
    ],
  });
}

function firecrawlResponse() {
  return okJson({
    data: [
      {
        title: 'Firecrawl Result',
        url: 'https://example.com/firecrawl',
        description: 'Firecrawl search snippet',
        markdown: '# Firecrawl content',
      },
    ],
  });
}

test.afterEach(() => {
  global.fetch = originalFetch;
  restoreEnv();
});

test('browse() uses Tavily when TAVILY_API_KEY is set and request succeeds', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  delete process.env.FIRECRAWL_API_KEY;

  mockFetch((url) => {
    assert.equal(url, 'https://api.tavily.com/search');
    return tavilyResponse();
  });

  const result = await browse('latest market news');

  assert.equal(result.ok, true);
  assert.equal(result.source, 'tavily');
  assert.equal(result.results[0].title, 'Tavily Result');
});

test('browse() falls back to Firecrawl when Tavily returns non-OK status', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  let calls = 0;

  mockFetch((url) => {
    calls += 1;
    if (url.includes('tavily')) return errorResponse(429);
    if (url.includes('firecrawl')) return firecrawlResponse();
    throw new Error(`Unexpected URL ${url}`);
  });

  const result = await browse('latest market news');

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'firecrawl');
});

test('browse() falls back to Firecrawl when Tavily throws network error', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.FIRECRAWL_API_KEY = 'fc-test';

  mockFetch((url) => {
    if (url.includes('tavily')) throw new Error('network error');
    if (url.includes('firecrawl')) return firecrawlResponse();
    throw new Error(`Unexpected URL ${url}`);
  });

  const result = await browse('latest market news');

  assert.equal(result.ok, true);
  assert.equal(result.source, 'firecrawl');
});

test('browse() returns source=none when both Tavily and Firecrawl fail', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  process.env.FIRECRAWL_API_KEY = 'fc-test';

  mockFetch(() => {
    throw new Error('network down');
  });

  const result = await browse('latest market news');

  assert.equal(result.ok, false);
  assert.equal(result.source, 'none');
  assert.match(result.error, /network down/);
});

test('browse() skips Tavily and uses Firecrawl when only FIRECRAWL_API_KEY is set', async () => {
  delete process.env.TAVILY_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'fc-test';

  mockFetch((url) => {
    assert.equal(url, 'https://api.firecrawl.dev/v1/search');
    return firecrawlResponse();
  });

  const result = await browse('latest market news');

  assert.equal(result.ok, true);
  assert.equal(result.source, 'firecrawl');
});

test('browse() result items contain title, url, snippet fields', async () => {
  process.env.TAVILY_API_KEY = 'tvly-test';
  delete process.env.FIRECRAWL_API_KEY;

  mockFetch(() => tavilyResponse());

  const result = await browse('latest market news');

  assert.equal(result.ok, true);
  assert.ok(result.results.length > 0);
  for (const item of result.results) {
    assert.equal(typeof item.title, 'string');
    assert.notEqual(item.title, '');
    assert.equal(typeof item.url, 'string');
    assert.notEqual(item.url, '');
    assert.equal(typeof item.snippet, 'string');
  }
});
