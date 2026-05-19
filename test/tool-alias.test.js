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

async function testBrevoEmailUsesWebFetchFirstAndDropsPlaceholders() {
  const calls = [];
  const webFetchTool = {
    manifest: {
      name: 'web-fetch',
      description: 'Search the internet for real-time information',
      version: '1.0.0',
      entry: 'index.js',
      enabled: true,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async run(input) {
      calls.push({ tool: 'web-fetch', input });
      return 'Harga emas hari ini: contoh data real-time.';
    },
  };
  const brevoTool = {
    manifest: {
      name: 'brevo-email',
      description: 'Send HTML email through Brevo',
      version: '1.0.0',
      entry: 'index.js',
      enabled: true,
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          htmlContent: { type: 'string' },
          recipientEmail: { type: 'string' },
          recipientName: { type: 'string' },
        },
        required: ['subject', 'htmlContent'],
      },
    },
    async run(input) {
      calls.push({ tool: 'brevo-email', input });
      assert.equal(input.recipientEmail, undefined);
      assert.equal(input.recipientName, undefined);
      return JSON.stringify({
        ok: true,
        status: 201,
        messageId: '<brevo-test>',
        recipientEmail: 'configured@test.com',
        content: 'Brevo email sent to configured@test.com from sender@test.com: <brevo-test>',
      });
    },
  };

  const registry = {
    listTools() {
      return [webFetchTool, brevoTool];
    },
    getTool(name) {
      if (name === 'web-fetch') return webFetchTool;
      if (name === 'brevo-email') return brevoTool;
      return undefined;
    },
  };

  let llmCalls = 0;
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    async listModels() {
      return [];
    },
    async chat() {
      llmCalls++;
      return {
        model: 'fake',
        latencyMs: 1,
        message: createMessage({
          role: 'assistant',
          content: JSON.stringify({
            type: 'tool_call',
            tool: 'brevo-email',
            input: {
              subject: 'Harga emas hari ini',
              htmlContent: '<p>Harga emas hari ini.</p>',
              recipientEmail: 'email@example.com',
              recipientName: 'Nama Penerima',
            },
          }),
        }),
      };
    },
  };

  const loop = new ToolLoop(registry, { maxSteps: 3 });
  const result = await loop.run(
    provider,
    'fake',
    [createMessage({ role: 'user', content: 'kirim email mengenai harga emas hari ini' })],
    'system'
  );

  assert.equal(llmCalls, 2);
  assert.deepEqual(result.toolsUsed, ['web-fetch', 'brevo-email']);
  assert.deepEqual(calls.map((call) => call.tool), ['web-fetch', 'brevo-email']);
  assert.match(result.finalText, /Email berhasil dikirim ke configured@test\.com/);
}

async function testBrevoFailureCannotBecomeSuccess() {
  const brevoTool = {
    manifest: {
      name: 'brevo-email',
      description: 'Send HTML email through Brevo',
      version: '1.0.0',
      entry: 'index.js',
      enabled: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async run() {
      return JSON.stringify({
        ok: false,
        status: 401,
        error: 'Key not found',
        content: 'Brevo email not sent. Key not found',
      });
    },
  };
  const registry = {
    listTools() {
      return [brevoTool];
    },
    getTool(name) {
      return name === 'brevo-email' ? brevoTool : undefined;
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
            tool: 'brevo-email',
            input: { subject: 'Test', htmlContent: '<p>Test</p>' },
          }),
        }),
      };
    },
  };

  const loop = new ToolLoop(registry, { maxSteps: 2 });
  const result = await loop.run(
    provider,
    'fake',
    [createMessage({ role: 'user', content: 'kirim email test' })],
    'system'
  );

  assert.match(result.finalText, /Email gagal dikirim/);
  assert.doesNotMatch(result.finalText, /berhasil dikirim|successfully sent/i);
}

(async () => {
  await testAliasExecutesWebFetch();
  await testNoToolsDiagnostic();
  await testBrevoEmailUsesWebFetchFirstAndDropsPlaceholders();
  await testBrevoFailureCannotBecomeSuccess();
  console.log('tool-alias tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
