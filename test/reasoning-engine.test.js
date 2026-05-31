const test = require('node:test');
const assert = require('node:assert/strict');
const { ReasoningEngine } = require('../dist/agents/reasoning-engine');
const { isApplicationDebugRequest } = require('../dist/agents/application-debug-intent');
const { isSelfUpgradeIntent } = require('../dist/self-healing');
const { createMessage } = require('../dist/types/message');

function mockRegistryWithWebFetch() {
  return {
    listTools() {
      return [{
        manifest: {
          name: 'web-fetch',
          description: 'Search the internet for real-time information',
          version: '1.0.0',
          entry: 'x',
          enabled: true,
        },
        run: async () => 'mock result',
      }];
    },
  };
}

function mockProvider(needsTool, tool = null, calls = { count: 0 }) {
  return {
    id: 'mock',
    displayName: 'Mock',
    async listModels() { return []; },
    async chat() {
      calls.count++;
      return {
        model: 'mock',
        latencyMs: 1,
        message: createMessage({
          role: 'assistant',
          content: JSON.stringify({ needsTool, tool, reason: 'test reason' }),
        }),
      };
    },
  };
}

function mockRegistryWithSystemExecute() {
  return {
    listTools() {
      return [{
        manifest: {
          name: 'system-execute',
          description: 'Run allowed shell commands',
          version: '1.0.0',
          entry: 'x',
          enabled: true,
        },
        run: async () => 'mock command output',
      }];
    },
  };
}

test('ReasoningEngine detects web-fetch need via regex shortcut', async () => {
  const calls = { count: 0 };
  const engine = new ReasoningEngine(mockRegistryWithWebFetch());
  const result = await engine.reason(
    'berita transfer sepakbola Eropa terbaru',
    mockProvider(false, null, calls),
    'mock'
  );
  assert.equal(result.needsTool, true);
  assert.equal(result.tool, 'web-fetch');
  assert.equal(calls.count, 0);
});

test('ReasoningEngine avoids Indonesian current-info false positives', async () => {
  const falsePositives = [
    'hari ini saya ulang tahun',
    'terbaru dari saya adalah laporan ini',
    'berita baik, saya sudah selesai',
    'beri saya ide yang fresh dan terbaru',
    'kabar gembira hari ini',
  ];

  for (const input of falsePositives) {
    const engine = new ReasoningEngine(mockRegistryWithWebFetch());
    const result = await engine.reason(input, mockProvider(false, null), 'mock');
    assert.equal(result.needsTool, false, input);
    assert.equal(result.tool, null, input);
  }
});

test('ReasoningEngine keeps true positives for real-time lookup', async () => {
  const truePositives = [
    'berita transfer sepakbola Eropa terbaru',
    'harga emas hari ini',
    'update pasar crypto sekarang',
    "what is the latest news today",
    'current Bitcoin price',
    'berita terbaru tentang AI',
  ];

  for (const input of truePositives) {
    const engine = new ReasoningEngine(mockRegistryWithWebFetch());
    const result = await engine.reason(input, mockProvider(false, null), 'mock');
    assert.equal(result.needsTool, true, input);
    assert.equal(result.tool, 'web-fetch', input);
  }
});

test('ReasoningEngine can still use LLM reasoning for edge cases outside regex', async () => {
  const calls = { count: 0 };
  const engine = new ReasoningEngine(mockRegistryWithWebFetch());
  const result = await engine.reason(
    'tolong cari info cuaca Jakarta',
    mockProvider(true, 'web-fetch', calls),
    'mock'
  );
  assert.equal(calls.count, 1);
  assert.equal(result.needsTool, true);
  assert.equal(result.tool, 'web-fetch');
});

test('ReasoningEngine returns no tool for general question', async () => {
  const engine = new ReasoningEngine(mockRegistryWithWebFetch());
  const result = await engine.reason(
    'apa itu TypeScript?',
    mockProvider(false, null),
    'mock'
  );
  assert.equal(result.needsTool, false);
  assert.equal(result.tool, null);
});

test('ReasoningEngine handles empty tool registry gracefully', async () => {
  const emptyRegistry = { listTools: () => [] };
  const engine = new ReasoningEngine(emptyRegistry);
  const result = await engine.reason('test', mockProvider(false), 'mock');
  assert.equal(result.needsTool, false);
});

test('ReasoningEngine normalizes known web aliases from LLM', async () => {
  const engine = new ReasoningEngine(mockRegistryWithWebFetch());
  const result = await engine.reason(
    'please consult an external source',
    mockProvider(true, 'news_api'),
    'mock'
  );
  assert.equal(result.tool, 'web-fetch');
  assert.equal(result.needsTool, true);
});

test('ReasoningEngine falls back gracefully when provider fails', async () => {
  const failProvider = {
    id: 'fail',
    displayName: 'Fail',
    async listModels() { return []; },
    async chat() { throw new Error('provider error'); },
  };
  const engine = new ReasoningEngine(mockRegistryWithWebFetch());
  const result = await engine.reason('test', failProvider, 'mock');
  assert.equal(result.needsTool, false);
  assert.equal(result.tool, null);
});

test('ReasoningEngine does not route Native OpenClaw logging debug requests to system-execute', async () => {
  const calls = { count: 0 };
  const engine = new ReasoningEngine(mockRegistryWithSystemExecute());
  const result = await engine.reason(
    'hilangkan notif error : Telegram polling error',
    mockProvider(true, 'system-execute', calls),
    'mock'
  );

  assert.equal(isApplicationDebugRequest('hilangkan notif error : Telegram polling error'), true);
  assert.equal(calls.count, 0);
  assert.equal(result.needsTool, false);
  assert.equal(result.tool, null);
  assert.match(result.reason, /Application logging\/config debug request/);
});

test('ReasoningEngine still allows explicit command requests to choose system-execute', async () => {
  const calls = { count: 0 };
  const engine = new ReasoningEngine(mockRegistryWithSystemExecute());
  const result = await engine.reason(
    'jalankan command docker logs native-openclaw',
    mockProvider(true, 'system-execute', calls),
    'mock'
  );

  assert.equal(isApplicationDebugRequest('jalankan command docker logs native-openclaw'), false);
  assert.equal(calls.count, 1);
  assert.equal(result.needsTool, true);
  assert.equal(result.tool, 'system-execute');
});

test('ReasoningEngine does not route self-upgrade token requests to system-execute', async () => {
  const input = 'analisa lalu upgrade, dalam efisiensi penggunaan token, usahakan jangan sampai ada notif : Request too large for model';
  const calls = { count: 0 };
  const engine = new ReasoningEngine(mockRegistryWithSystemExecute());
  const result = await engine.reason(
    input,
    mockProvider(true, 'system-execute', calls),
    'mock'
  );

  assert.equal(isSelfUpgradeIntent(input), true);
  assert.equal(calls.count, 0);
  assert.equal(result.needsTool, false);
  assert.equal(result.tool, null);
  assert.match(result.reason, /Self-upgrade request/);
});

test('isSelfUpgradeIntent detects explicit agent/capability upgrades without standalone upgrade false positives', () => {
  const positives = [
    '/upgrade run add feature',
    'tambahkan fitur baru',
    'optimalkan penggunaan token',
    'cegah request too large',
    'upgrade native-openclaw',
    'upgrade kemampuan agent',
  ];
  const negatives = [
    'upgrade plan ke premium',
    'bagaimana cara upgrade OS?',
    'upgrade database version?',
    'saya mau upgrade paket internet',
    'upgrade npm package apa?',
    'upgrade akun',
    'upgrade langganan',
    'apa itu self-upgrade?',
    'jelaskan self-upgrade',
    'bagaimana cara kerja self-healing?',
  ];

  for (const input of positives) {
    assert.equal(isSelfUpgradeIntent(input), true, input);
  }
  for (const input of negatives) {
    assert.equal(isSelfUpgradeIntent(input), false, input);
  }
});
