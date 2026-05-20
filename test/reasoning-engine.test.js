const test = require('node:test');
const assert = require('node:assert/strict');
const { ReasoningEngine } = require('../dist/agents/reasoning-engine');
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
