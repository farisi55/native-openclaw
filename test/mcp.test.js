const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const { McpManager, loadMcpConfig } = require('../dist/mcp');
const { ToolRegistry } = require('../dist/tools/tool-registry');
const { cmdMcp } = require('../dist/cli/commands');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-openclaw-mcp-'));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function captureStdout(fn) {
  const original = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk, ...args) => {
    out += String(chunk);
    const cb = args.find((arg) => typeof arg === 'function');
    if (cb) cb();
    return true;
  };
  try {
    await fn();
    return out.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    process.stdout.write = original;
  }
}

async function writeFakeMcpServer(dir) {
  const file = path.join(dir, 'fake-mcp-server.js');
  await fs.writeFile(file, `
let buffer = Buffer.alloc(0);

function send(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}

function handle(message) {
  if (!message.id) return;
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' }
    });
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, {
      tools: [{
        name: 'echo',
        description: 'Echo test input',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Text to echo' } },
          required: ['text']
        }
      }]
    });
    return;
  }
  if (message.method === 'tools/call') {
    const text = message.params && message.params.arguments ? message.params.arguments.text : '';
    send(message.id, { content: [{ type: 'text', text: 'echo:' + text }] });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('utf-8');
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const body = buffer.subarray(start, end).toString('utf-8');
    buffer = buffer.subarray(end);
    handle(JSON.parse(body));
  }
});
`, 'utf-8');
  return file;
}

function makeCtx(manager, registry) {
  return {
    providers: new Map(),
    skillRegistry: { activeIds: [], size: 0 },
    sessions: {},
    settings: {},
    toolRegistry: registry,
    mcpManager: manager,
    activeProvider: {},
    activeModel: 'test',
    activeSessionId: null,
    setProvider() {},
    setModel() {},
    async setSession() {},
  };
}

async function testConfigAutoCreated() {
  await withTempDir(async (dir) => {
    const configPath = path.join(dir, 'data', 'mcp.json');
    const config = await loadMcpConfig(configPath);
    assert.deepStrictEqual(config, { mcpServers: {} });
    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    assert.deepStrictEqual(raw, { mcpServers: {} });
  });
}

async function testCliAddAndList() {
  await withTempDir(async (dir) => {
    const registry = new ToolRegistry(dir);
    const manager = new McpManager({ configPath: path.join(dir, 'mcp.json'), toolRegistry: registry });
    await manager.init();
    const ctx = makeCtx(manager, registry);

    await cmdMcp(ctx, ['add', 'console']);
    const out = await captureStdout(() => cmdMcp(ctx, ['list']));
    assert.match(out, /console/);
    assert.match(out, /@ooples\/mcp-console-automation/);
  });
}

async function testStartListAndCallFakeServer() {
  await withTempDir(async (dir) => {
    const serverPath = await writeFakeMcpServer(dir);
    const registry = new ToolRegistry(dir);
    const manager = new McpManager({ configPath: path.join(dir, 'mcp.json'), toolRegistry: registry });
    await manager.init();
    await manager.addServer('fake', { command: process.execPath, args: [serverPath] });

    const tools = await manager.startServer('fake');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, 'echo');

    const runtimeTool = registry.getTool('mcp:fake:echo');
    assert.ok(runtimeTool);
    const result = await runtimeTool.run({ text: 'hello' });
    assert.strictEqual(result, 'echo:hello');

    const listed = manager.listTools('fake');
    assert.strictEqual(listed[0].runtimeName, 'mcp:fake:echo');
    await manager.stopServer('fake');
    assert.strictEqual(registry.has('mcp:fake:echo'), false);
  });
}

async function testRestartServerReRegistersTools() {
  await withTempDir(async (dir) => {
    const serverPath = await writeFakeMcpServer(dir);
    const registry = new ToolRegistry(dir);
    const manager = new McpManager({
      configPath: path.join(dir, 'mcp.json'),
      toolRegistry: registry,
    });
    await manager.init();
    await manager.addServer('fake', { command: process.execPath, args: [serverPath] });

    // Initial start
    const toolsFirst = await manager.startServer('fake');
    assert.strictEqual(toolsFirst.length, 1, 'should have 1 tool after first start');
    assert.ok(registry.has('mcp:fake:echo'), 'tool must be registered after start');

    // Restart
    const toolsAfter = await manager.restartServer('fake');
    assert.strictEqual(toolsAfter.length, 1, 'should have 1 tool after restart');
    assert.ok(registry.has('mcp:fake:echo'), 'tool must be re-registered after restart');

    // Verify tool still callable after restart
    const runtimeTool = registry.getTool('mcp:fake:echo');
    assert.ok(runtimeTool, 'getTool must return a tool after restart');
    const result = await runtimeTool.run({ text: 'restart-test' });
    assert.strictEqual(result, 'echo:restart-test', 'tool must return correct output after restart');

    await manager.stopServer('fake');
    assert.strictEqual(registry.has('mcp:fake:echo'), false, 'tool must be unregistered after stop');
  });
}

async function testFailedServerDoesNotCrashStartAll() {
  await withTempDir(async (dir) => {
    const registry = new ToolRegistry(dir);
    const manager = new McpManager({ configPath: path.join(dir, 'mcp.json'), toolRegistry: registry });
    await manager.init();
    await manager.addServer('bad', { command: process.execPath, args: [path.join(dir, 'missing.js')] });

    const results = await manager.startAllConfigured();
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].name, 'bad');
    assert.strictEqual(results[0].ok, false);
  });
}

async function run() {
  await testConfigAutoCreated();
  await testCliAddAndList();
  await testStartListAndCallFakeServer();
  await testRestartServerReRegistersTools();
  await testFailedServerDoesNotCrashStartAll();
  console.log('mcp tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
