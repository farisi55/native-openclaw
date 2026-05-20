const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ContextCompressor } = require('../dist/memory/context-compressor');
const { SemanticMemory } = require('../dist/memory/semantic-memory');
const { createMessage } = require('../dist/types/message');

function makeMessages(count) {
  return Array.from({ length: count }, (_, i) =>
    createMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `message ${i}` })
  );
}

async function withCompressor(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-compressor-'));
  try {
    const memory = new SemanticMemory(dir);
    await memory.load();
    const compressor = new ContextCompressor(memory);
    await fn(compressor, memory);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('short history is not compressed', async () => {
  await withCompressor(async (compressor) => {
    const messages = makeMessages(4);
    const result = compressor.compress(messages, 'test query', 'session-1');
    assert.equal(result.memoriesInjected, 0);
    assert.equal(result.messages.length, 4);
    assert.equal(result.originalCount, 4);
  });
});

test('long history is windowed to recentWindowSize', async () => {
  await withCompressor(async (compressor) => {
    const messages = makeMessages(20);
    const result = compressor.compress(messages, 'test query', 'session-1', {
      recentWindowSize: 6,
    });
    assert.ok(result.messages.length <= 8, 'Should not exceed window size significantly');
    assert.ok(result.originalCount > result.compressedCount);
  });
});

test('system messages are stripped', async () => {
  await withCompressor(async (compressor) => {
    const messages = [
      createMessage({ role: 'system', content: 'system prompt' }),
      createMessage({ role: 'user', content: 'user message' }),
      createMessage({ role: 'assistant', content: 'assistant reply' }),
    ];
    const result = compressor.compress(messages, 'query', 'session-1');
    assert.ok(
      result.messages.every((m) => m.role !== 'system'),
      'System messages should be stripped'
    );
  });
});

test('storeExchange saves to semantic memory', async () => {
  await withCompressor(async (compressor, memory) => {
    compressor.storeExchange('session-1', 'harga emas', 'Harga emas $1950');
    assert.equal(memory.size(), 2);
  });
});

test('result always starts with user message', async () => {
  await withCompressor(async (compressor) => {
    const messages = makeMessages(16);
    const result = compressor.compress(messages, 'query', 'session-1', {
      recentWindowSize: 6,
    });
    if (result.messages.length > 0) {
      assert.equal(result.messages[0].role, 'user', 'First message must be from user');
    }
  });
});
