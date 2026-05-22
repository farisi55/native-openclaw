import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../dist/agents/orchestrator');
const { ContextCompressor } = require('../dist/memory/context-compressor');
const { SemanticMemory } = require('../dist/memory/semantic-memory');
const { SkillRegistry } = require('../dist/skills/registry');
const { MemoryManager } = require('../dist/storage/memory-manager');
const { SessionManager } = require('../dist/storage/session-manager');
const { createMessage } = require('../dist/types/message');
const { WorkspaceManager } = require('../dist/workspace');

function provider(content = 'Hello from mock provider.') {
  return {
    id: 'mock-provider',
    displayName: 'Mock Provider',
    async listModels() {
      return [{ id: 'mock-model' }];
    },
    async chat() {
      return {
        message: createMessage({ role: 'assistant', content }),
        model: 'mock-model',
        latencyMs: 1,
      };
    },
  };
}

function router() {
  return {
    async chat(primaryProvider: any, primaryModel: string, options: any) {
      const response = await primaryProvider.chat({ ...options, model: primaryModel });
      return {
        response,
        providerId: primaryProvider.id,
        model: primaryModel,
        usedFallback: false,
        attemptCount: 1,
      };
    },
  };
}

function toolRegistry() {
  return {
    listTools() {
      return [];
    },
    buildToolsBlock() {
      return '';
    },
    getTool() {
      return undefined;
    },
  };
}

async function withOrchestrator(
  fn: (ctx: {
    orchestrator: any;
    memory: any;
    provider: any;
  }) => Promise<void>,
  opts: Record<string, unknown> = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-orchestrator-ts-'));
  const previousWorkspace = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = join(dir, 'workspace');

  try {
    const semantic = new SemanticMemory(dir);
    await semantic.load();
    const memory = new MemoryManager(dir);
    const workspace = new WorkspaceManager({ rootDir: join(dir, 'workspace') });
    const mockProvider = provider();
    const orchestrator = new Orchestrator(
      new SessionManager(dir),
      new SkillRegistry(),
      memory,
      toolRegistry(),
      router(),
      new ContextCompressor(semantic),
      workspace,
      {
        useReasoning: false,
        useSemanticCompression: false,
        maxToolSteps: 0,
        ...opts,
      }
    );

    await fn({ orchestrator, memory, provider: mockProvider });
  } finally {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_DIR;
    else process.env.WORKSPACE_DIR = previousWorkspace;
    await rm(dir, { recursive: true, force: true });
  }
}

test('turn with mock provider returns non-empty assistant text', async () => {
  await withOrchestrator(async ({ orchestrator, provider: mockProvider }) => {
    const result = await orchestrator.turn({
      provider: mockProvider,
      model: 'mock-model',
      userInput: 'hello',
    });

    assert.equal(typeof result.assistantText, 'string');
    assert.ok(result.assistantText.length > 0);
  });
});

test('turn count maxTurns is enforced', async () => {
  await withOrchestrator(async ({ orchestrator, provider: mockProvider }) => {
    const first = await orchestrator.turn({
      provider: mockProvider,
      model: 'mock-model',
      userInput: 'first',
    });

    await assert.rejects(
      () => orchestrator.turn({
        provider: mockProvider,
        model: 'mock-model',
        sessionId: first.session.id,
        userInput: 'second',
      }),
      /maximum|turns/i
    );
  }, { maxTurns: 1 });
});

test('unknown sessionId throws', async () => {
  await withOrchestrator(async ({ orchestrator, provider: mockProvider }) => {
    await assert.rejects(
      () => orchestrator.turn({
        provider: mockProvider,
        model: 'mock-model',
        sessionId: 'missing-session',
        userInput: 'hello',
      }),
      /not found/i
    );
  });
});

test('memory extraction writes durable facts to memory store', async () => {
  await withOrchestrator(async ({ orchestrator, memory, provider: mockProvider }) => {
    await orchestrator.turn({
      provider: mockProvider,
      model: 'mock-model',
      userInput: 'remember that favorite color is blue',
    });

    assert.equal(await memory.getGlobalValue('favorite_color'), 'blue');
  });
});
