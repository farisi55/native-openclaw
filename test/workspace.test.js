const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { WorkspaceManager, workspaceAppend } = require('../dist/workspace');
const { cmdWorkspace } = require('../dist/cli/commands');
const { ToolRegistry } = require('../dist/tools/tool-registry');

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-workspace-test-'));
  const previous = process.env.WORKSPACE_DIR;
  process.env.WORKSPACE_DIR = root;
  try {
    await fn(root);
  } finally {
    if (previous === undefined) {
      delete process.env.WORKSPACE_DIR;
    } else {
      process.env.WORKSPACE_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
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
    return output;
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

test('workspace auto-creates default structure', async () => {
  await withWorkspace(async (root) => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();

    for (const file of ['AGENTS.md', 'BOOTSTRAP.md', 'HEARTBEAT.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md']) {
      assert.equal(existsSync(join(root, file)), true, `${file} should exist`);
    }
    assert.equal(existsSync(join(root, 'state')), true);
  });
});

test('/workspace list and read work', async () => {
  await withWorkspace(async () => {
    const listOutput = await captureStdout(() => cmdWorkspace(ctx(), ['list']));
    assert.match(listOutput, /AGENTS\.md/);

    const readOutput = await captureStdout(() => cmdWorkspace(ctx(), ['read', 'AGENTS.md']));
    assert.match(readOutput, /Native OpenClaw/);
  });
});

test('workspace append tool can create MEMORY.md', async () => {
  await withWorkspace(async () => {
    const result = await workspaceAppend({ path: 'MEMORY.md', content: 'Remember this checkpoint.' });
    assert.equal(result.ok, true);

    const workspace = new WorkspaceManager();
    const content = await workspace.read('MEMORY.md');
    assert.match(content, /Remember this checkpoint/);
  });
});

test('workspace path traversal is blocked', async () => {
  await withWorkspace(async () => {
    const workspace = new WorkspaceManager();
    assert.throws(() => workspace.resolvePath('../outside.md'), /traversal/);
    assert.throws(() => workspace.resolvePath('state/../../outside.md'), /traversal/);
    assert.throws(() => workspace.resolvePath(join(tmpdir(), 'outside.md')), /relative/);
  });
});

test('workspace tools are exposed through ToolRegistry', async () => {
  await withWorkspace(async () => {
    const registry = new ToolRegistry(resolve(__dirname, '..'));
    await registry.loadTools();

    for (const name of ['workspace-list', 'workspace-read', 'workspace-write', 'workspace-append', 'workspace-mkdir']) {
      assert.equal(registry.has(name), true, `${name} should be registered`);
    }

    const mkdir = registry.getTool('workspace-mkdir');
    const append = registry.getTool('workspace-append');
    const read = registry.getTool('workspace-read');
    assert.ok(mkdir);
    assert.ok(append);
    assert.ok(read);

    await mkdir.run({ path: 'reports' });
    await append.run({ path: 'reports/check.md', content: 'workspace tool output' });
    const content = await read.run({ path: 'reports/check.md' });
    assert.match(content, /workspace tool output/);
  });
});
