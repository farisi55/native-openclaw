import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProviderRouter } = require('../dist/router/provider-router');
const { createMessage } = require('../dist/types/message');

function provider(id: string, behavior: 'ok' | 'fail' = 'ok') {
  let calls = 0;
  return {
    id,
    displayName: id,
    get calls() {
      return calls;
    },
    async listModels() {
      return [{ id: `${id}-model` }];
    },
    async chat() {
      calls += 1;
      if (behavior === 'fail') throw new Error(`${id} failed`);
      return {
        message: createMessage({ role: 'assistant', content: `${id} ok` }),
        model: `${id}-model`,
        latencyMs: 1,
      };
    },
  };
}

async function withRouter(providers: Map<string, unknown>, enabled: boolean, fn: (router: unknown) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-router-ts-'));
  try {
    const router = new ProviderRouter(providers, {
      enabled,
      autoFallback: true,
      autoSwitch: false,
      maxAttempts: 3,
      dataDir: dir,
    });
    await router.init();
    await fn(router);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Primary provider healthy returns response directly', async () => {
  const primary = provider('primary');
  await withRouter(new Map([['primary', primary]]), true, async (router: any) => {
    const result = await router.chat(primary, 'primary-model', { messages: [], systemPrompt: '' });
    assert.equal(result.providerId, 'primary');
    assert.equal(result.usedFallback, false);
  });
});

test('Primary provider throws then fallback provider is used', async () => {
  const primary = provider('primary', 'fail');
  const fallback = provider('fallback');
  await withRouter(new Map([['primary', primary], ['fallback', fallback]]), true, async (router: any) => {
    const result = await router.chat(primary, 'primary-model', { messages: [], systemPrompt: '' });
    assert.equal(result.providerId, 'fallback');
    assert.equal(result.usedFallback, true);
  });
});

test('Preferred provider is attempted before fallback providers', async () => {
  const preferred = provider('puter', 'fail');
  const fallback = provider('groq');
  await withRouter(new Map([['puter', preferred], ['groq', fallback]]), true, async (router: any) => {
    const result = await router.chat(preferred, 'gpt-5-nano', { messages: [], systemPrompt: '' });
    assert.equal((preferred as any).calls, 1);
    assert.equal((fallback as any).calls, 1);
    assert.equal(result.providerId, 'groq');
    assert.equal(result.usedFallback, true);
  });
});

test('All providers throw propagates error', async () => {
  const primary = provider('primary', 'fail');
  const fallback = provider('fallback', 'fail');
  await withRouter(new Map([['primary', primary], ['fallback', fallback]]), true, async (router: any) => {
    await assert.rejects(
      () => router.chat(primary, 'primary-model', { messages: [], systemPrompt: '' }),
      /failed/
    );
  });
});

test('Router disabled uses single provider and does not fallback', async () => {
  const primary = provider('primary');
  const fallback = provider('fallback');
  await withRouter(new Map([['primary', primary], ['fallback', fallback]]), false, async (router: any) => {
    const result = await router.chat(primary, 'primary-model', { messages: [], systemPrompt: '' });
    assert.equal(result.providerId, 'primary');
    assert.equal((fallback as any).calls, 0);
  });
});
