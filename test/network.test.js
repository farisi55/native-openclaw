const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  getDnsServers,
  getProxyConfig,
  getProxyForUrl,
  maskProxyUrl,
  networkCheck,
  shouldBypassProxy,
} = require('../dist/network');
const { cmdNetwork } = require('../dist/cli/commands');

const savedEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  no_proxy: process.env.no_proxy,
  DNS_SERVERS: process.env.DNS_SERVERS,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearNetworkEnv() {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;
  delete process.env.no_proxy;
  delete process.env.DNS_SERVERS;
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) callback();
    return true;
  };

  try {
    await fn();
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    process.stdout.write = originalWrite;
  }
}

function ctx() {
  return {
    providers: new Map(),
    skillRegistry: { activeIds: [] },
    sessions: {},
    settings: {},
    toolRegistry: {},
    activeProvider: {},
    activeModel: 'test',
    activeSessionId: null,
    setProvider() {},
    setModel() {},
    async setSession() {},
  };
}

test.afterEach(() => {
  restoreEnv();
});

test('no proxy env leaves proxy config empty', () => {
  clearNetworkEnv();
  const cfg = getProxyConfig();
  assert.equal(cfg.httpProxy, null);
  assert.equal(cfg.httpsProxy, null);
  assert.deepEqual(cfg.noProxy, []);
  assert.equal(getProxyForUrl('https://api.openai.com/v1/models'), null);
});

test('HTTPS_PROXY is selected for https URLs and masked for display', () => {
  clearNetworkEnv();
  process.env.HTTPS_PROXY = 'http://user:pass@proxy.local:8080';

  assert.equal(getProxyForUrl('https://api.openai.com/v1/models'), 'http://user:pass@proxy.local:8080');
  assert.equal(maskProxyUrl(process.env.HTTPS_PROXY), 'http://***:***@proxy.local:8080/');
});

test('NO_PROXY bypasses localhost and matching domains', () => {
  clearNetworkEnv();
  process.env.HTTPS_PROXY = 'http://proxy.local:8080';
  process.env.NO_PROXY = 'localhost,127.0.0.1,.internal.test,example.com';

  assert.equal(shouldBypassProxy('http://localhost:3000'), true);
  assert.equal(shouldBypassProxy('http://127.0.0.1:18789'), true);
  assert.equal(shouldBypassProxy('https://api.internal.test/path'), true);
  assert.equal(shouldBypassProxy('https://example.com'), true);
  assert.equal(getProxyForUrl('https://api.openai.com'), 'http://proxy.local:8080');
});

test('DNS_SERVERS parses and /network dns displays configured DNS', async () => {
  clearNetworkEnv();
  process.env.DNS_SERVERS = '8.8.8.8,1.1.1.1';

  assert.deepEqual(getDnsServers(), ['8.8.8.8', '1.1.1.1']);
  const output = await captureStdout(() => cmdNetwork(ctx(), ['dns']));
  assert.match(output, /8\.8\.8\.8, 1\.1\.1\.1/);
});

test('/network proxy masks credentials', async () => {
  clearNetworkEnv();
  process.env.HTTP_PROXY = 'http://user:pass@proxy.local:8080';

  const output = await captureStdout(() => cmdNetwork(ctx(), ['proxy']));
  assert.match(output, /http:\/\/\*\*\*:\*\*\*@proxy\.local:8080\//);
  assert.doesNotMatch(output, /user:pass/);
});

test('networkCheck resolves localhost', async () => {
  clearNetworkEnv();
  const result = await networkCheck('localhost');
  assert.equal(result.ok, true);
  assert.ok(result.addresses.length > 0);
});
