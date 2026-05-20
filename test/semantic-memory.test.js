const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { SemanticMemory } = require('../dist/memory/semantic-memory');

async function withMemory(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-semantic-memory-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('store and retrieve returns relevant chunks', async () => {
  await withMemory(async (dir) => {
    const mem = new SemanticMemory(dir);
    await mem.load();

    mem.store('session-1', 'user', 'harga emas hari ini adalah $1950', 1);
    mem.store('session-1', 'assistant', 'Emas turun 0.5% dari kemarin', 1);
    mem.store('session-1', 'user', 'bagaimana cuaca Jakarta', 1);

    const results = mem.retrieve('berapa harga emas sekarang', 3, 'session-1');

    assert.ok(results.length > 0, 'Should find relevant results');
    assert.ok(
      results[0].chunk.content.toLowerCase().includes('emas'),
      'Most relevant chunk should mention emas'
    );
  });
});

test('retrieve respects maxAgeDays filter', async () => {
  await withMemory(async (dir) => {
    const mem = new SemanticMemory(dir);
    await mem.load();

    mem.store('session-1', 'user', 'old information about gold prices', 1);
    const chunks = mem.chunks;
    chunks[0].createdAt = Date.now() - (10 * 24 * 60 * 60 * 1000);

    const results = mem.retrieve('gold prices', 5, 'session-1', 7);
    assert.equal(results.length, 0, 'Should not return chunks older than maxAgeDays');
  });
});

test('save and load round-trip preserves data', async () => {
  await withMemory(async (dir) => {
    const mem1 = new SemanticMemory(dir);
    await mem1.load();
    mem1.store('session-1', 'user', 'important context here', 2);
    await mem1.save();

    const mem2 = new SemanticMemory(dir);
    await mem2.load();

    assert.equal(mem2.size(), 1);
    const results = mem2.retrieve('important context', 5);
    assert.equal(results.length, 1);
    assert.ok(results[0].chunk.content.includes('important context'));
  });
});

test('size() returns correct count', async () => {
  await withMemory(async (dir) => {
    const mem = new SemanticMemory(dir);
    await mem.load();
    assert.equal(mem.size(), 0);
    mem.store('s1', 'user', 'text 1', 1);
    mem.store('s1', 'user', 'text 2', 1);
    assert.equal(mem.size(), 2);
  });
});
