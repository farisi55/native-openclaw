const assert = require('node:assert/strict');

const { ToolLoop, normalizeToolName } = require('../dist/agents/tool-loop');
const { createMessage } = require('../dist/types/message');

assert.equal(normalizeToolName('news_api', ['web-fetch']), 'web-fetch');
assert.equal(normalizeToolName('web_search', ['web-fetch']), 'web-fetch');
assert.equal(normalizeToolName('NEWS_API', ['web-fetch']), 'web-fetch');
assert.equal(normalizeToolName('news_api', []), 'news_api');
assert.equal(normalizeToolName('system-time', ['system-time']), 'system-time');

async function testAliasExecutesWebFetch() {
  let ran = false;
  let calls = 0;

  const webFetchTool = {
    manifest: {
      name: 'web-fetch',
      description: 'Search the internet for real-time information',
      version: '1.0.0',
      entry: 'index.js',
      enabled: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    async run(input) {
      ran = true;
      assert.equal(input.query, 'berita transfer sepakbola Eropa');
      return 'Tool result: berita ditemukan';
    },
  };

  const registry = {
    listTools() {
      return [webFetchTool];
    },
    getTool(name) {
      return name === 'web-fetch' ? webFetchTool : undefined;
    },
  };

  const provider = {
    id: 'fake',
    displayName: 'Fake',
    async listModels() {
      return [];
    },
    async chat() {
      calls++;
      return {
        model: 'fake',
        latencyMs: 1,
        message: createMessage({
          role: 'assistant',
          content:
            calls === 1
              ? JSON.stringify({
                  type: 'tool_call',
                  tool: 'news_api',
                  input: { query: 'berita transfer sepakbola Eropa' },
                })
              : JSON.stringify({
                  type: 'final_response',
                  content: 'Berita ditemukan.',
                }),
        }),
      };
    },
  };

  const loop = new ToolLoop(registry, { maxSteps: 2 });
  const result = await loop.run(
    provider,
    'fake',
    [createMessage({ role: 'user', content: 'cek berita transfer sepakbola Eropa terbaru' })],
    'system'
  );

  assert.equal(ran, true);
  assert.deepEqual(result.toolsUsed, ['web-fetch']);
  assert.equal(result.finalText, 'Berita ditemukan.');
}

async function testNoToolsDiagnostic() {
  const registry = {
    listTools() {
      return [];
    },
    getTool() {
      return undefined;
    },
  };

  const provider = {
    id: 'fake',
    displayName: 'Fake',
    async listModels() {
      return [];
    },
    async chat() {
      return {
        model: 'fake',
        latencyMs: 1,
        message: createMessage({
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_call',
            tool: 'news_api',
            input: { query: 'berita transfer sepakbola Eropa' },
          }),
        }),
      };
    },
  };

  const loop = new ToolLoop(registry, { maxSteps: 2 });
  const result = await loop.run(
    provider,
    'fake',
    [createMessage({ role: 'user', content: 'cek berita transfer sepakbola Eropa terbaru' })],
    'system'
  );

  assert.match(result.finalText, /Tool execution is currently unavailable/);
  assert.doesNotMatch(result.finalText, /news_api|tool_call/);
  assert.equal(result.toolSteps, 0);
}

(async () => {
  await testAliasExecutesWebFetch();
  await testNoToolsDiagnostic();
  console.log('tool-alias tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
