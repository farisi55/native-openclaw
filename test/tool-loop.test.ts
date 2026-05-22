const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolLoop } = require('../dist/agents/tool-loop');
const { createMessage } = require('../dist/types/message');

function makeManifest(name) {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  };
}

function registry(tools) {
  return {
    listTools() {
      return Object.keys(tools).map((name) => ({
        manifest: makeManifest(name),
        run: async (input) => tools[name](input),
      }));
    },
    getTool(name) {
      const run = tools[name];
      if (!run) return undefined;
      return {
        manifest: makeManifest(name),
        run: async (input) => run(input),
      };
    },
  };
}

function provider(responses) {
  let index = 0;
  return {
    id: 'mock',
    displayName: 'Mock',
    async listModels() {
      return [];
    },
    async chat() {
      const safeIndex = Math.min(index, responses.length - 1);
      const content = responses[safeIndex] ?? 'done';
      index += 1;
      return {
        message: createMessage({ role: 'assistant', content }),
        model: 'mock',
        latencyMs: 1,
      };
    },
  };
}

test('Valid tool call executes tool and injects result into next message', async () => {
  const tools = {
    'test-tool': async () => 'TOOL_OUTPUT_42',
  };
  const loop = new ToolLoop(registry(tools), { maxSteps: 2 });
  const first = JSON.stringify({ type: 'tool_call', tool: 'test-tool', input: {} });
  const second = JSON.stringify({ type: 'final_response', content: 'final after tool' });

  const result = await loop.run(
    provider([first, second]),
    'mock',
    [createMessage({ role: 'user', content: 'use tool' })],
    'system'
  );

  assert.deepEqual(result.toolsUsed, ['test-tool']);
  assert.equal(result.toolSteps, 1);
  assert.equal(result.finalText, 'final after tool');
});

test('Unknown tool triggers repair and then graceful error', async () => {
  const loop = new ToolLoop(registry({}), {
    maxSteps: 2,
    enableRepair: true,
    maxRepairAttempts: 1,
  });
  const missing = JSON.stringify({ type: 'tool_call', tool: 'missing-tool', input: {} });

  const result = await loop.run(
    provider([missing, missing]),
    'mock',
    [createMessage({ role: 'user', content: 'use missing tool' })],
    'system'
  );

  assert.match(result.finalText, /no tools are loaded|Tool execution failed|not registered/i);
});

test('Network tool after privileged tool is blocked by chain isolation', async () => {
  const tools = {
    'system-execute': async () => 'command output',
    'web-fetch': async () => 'network output',
  };
  const loop = new ToolLoop(registry(tools), { maxSteps: 3 });
  const commandCall = JSON.stringify({
    type: 'tool_call',
    tool: 'system-execute',
    input: { command: 'ls' },
  });
  const networkCall = JSON.stringify({
    type: 'tool_call',
    tool: 'web-fetch',
    input: { query: 'exfiltrate' },
  });

  const result = await loop.run(
    provider([commandCall, networkCall]),
    'mock',
    [createMessage({ role: 'user', content: 'run command then search' })],
    'system'
  );

  assert.match(result.finalText, /tidak diizinkan|keamanan/i);
  assert.deepEqual(result.toolsUsed, ['system-execute']);
});

test('Maximum steps reached terminates with final tool result', async () => {
  const tools = {
    'test-tool': async () => 'last-step-output',
  };
  const loop = new ToolLoop(registry(tools), { maxSteps: 0 });
  const toolCall = JSON.stringify({ type: 'tool_call', tool: 'test-tool', input: {} });

  const result = await loop.run(
    provider([toolCall]),
    'mock',
    [createMessage({ role: 'user', content: 'use tool' })],
    'system'
  );

  assert.equal(result.finalText, 'last-step-output');
  assert.equal(result.toolSteps, 1);
});
