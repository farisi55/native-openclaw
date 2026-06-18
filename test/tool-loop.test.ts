const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ToolLoop,
  extractEmailPayloadFromDraft,
  extractRecipientEmail,
  userRequiresEmail,
} = require('../dist/agents/tool-loop');
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

test('enableTools=false does not inject tool contract into the provider system prompt', async () => {
  const tools = {
    'test-tool': async () => 'TOOL_OUTPUT_42',
  };
  let receivedSystemPrompt = '';
  const plainProvider = {
    id: 'mock',
    displayName: 'Mock',
    async listModels() {
      return [];
    },
    async chat(options) {
      receivedSystemPrompt = options.systemPrompt;
      return {
        message: createMessage({ role: 'assistant', content: 'Halo!' }),
        model: 'mock',
        latencyMs: 1,
      };
    },
  };

  const loop = new ToolLoop(registry(tools), { maxSteps: 1, enableTools: false });
  const result = await loop.run(
    plainProvider,
    'mock',
    [createMessage({ role: 'user', content: 'hello' })],
    'short system prompt'
  );

  assert.equal(result.finalText, 'Halo!');
  assert.equal(receivedSystemPrompt, 'short system prompt');
  assert.doesNotMatch(receivedSystemPrompt, /AVAILABLE TOOLS/);
  assert.doesNotMatch(receivedSystemPrompt, /test-tool/);
});

test('enableTools defaults to true and injects the tool contract', async () => {
  const tools = {
    'test-tool': async () => 'TOOL_OUTPUT_42',
  };
  let receivedSystemPrompt = '';
  const toolAwareProvider = {
    id: 'mock',
    displayName: 'Mock',
    async listModels() {
      return [];
    },
    async chat(options) {
      receivedSystemPrompt = options.systemPrompt;
      return {
        message: createMessage({
          role: 'assistant',
          content: JSON.stringify({ type: 'final_response', content: 'Done.' }),
        }),
        model: 'mock',
        latencyMs: 1,
      };
    },
  };

  const loop = new ToolLoop(registry(tools), { maxSteps: 1 });
  const result = await loop.run(
    toolAwareProvider,
    'mock',
    [createMessage({ role: 'user', content: 'use tool if needed' })],
    'system'
  );

  assert.equal(result.finalText, 'Done.');
  assert.match(receivedSystemPrompt, /AVAILABLE TOOLS/);
  assert.match(receivedSystemPrompt, /test-tool/);
});

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

test('isScheduledEmailJob=true: injects mandatory brevo-email instruction after web-fetch', async () => {
  let brevoCallCount = 0;
  let webFetchCallCount = 0;
  let chatCount = 0;

  const tools = {
    'web-fetch': async () => {
      webFetchCallCount++;
      return JSON.stringify({
        results: [{ title: 'Harga Emas', content: 'Rp 1.500.000/gram' }],
      });
    },
    'brevo-email': async () => {
      brevoCallCount++;
      return JSON.stringify({ ok: true, messageId: 'msg-123' });
    },
  };

  const webFetchCall = JSON.stringify({
    type: 'tool_call',
    tool: 'web-fetch',
    input: { query: 'harga emas' },
  });
  const brevoCall = JSON.stringify({
    type: 'tool_call',
    tool: 'brevo-email',
    input: { subject: 'Harga Emas', htmlContent: '<p>Rp 1.500.000</p>' },
  });

  const scheduledProvider = {
    id: 'mock',
    displayName: 'Mock',
    async listModels() {
      return [];
    },
    async chat(options) {
      chatCount++;
      if (chatCount === 1) {
        return {
          message: createMessage({ role: 'assistant', content: webFetchCall }),
          model: 'mock',
          latencyMs: 1,
        };
      }

      const lastMessage = options.messages[options.messages.length - 1];
      assert.match(
        String(lastMessage.content),
        /MANDATORY NEXT ACTION: You MUST now call the brevo-email tool/
      );

      return {
        message: createMessage({ role: 'assistant', content: brevoCall }),
        model: 'mock',
        latencyMs: 1,
      };
    },
  };

  const loop = new ToolLoop(registry(tools), { maxSteps: 5, isScheduledEmailJob: true });
  const result = await loop.run(
    scheduledProvider,
    'mock',
    [createMessage({ role: 'user', content: 'Cari harga emas dan kirim ke email' })],
    'You are an assistant.'
  );

  assert.equal(webFetchCallCount, 1);
  assert.equal(brevoCallCount, 1);
  assert.ok(result.toolsUsed.includes('brevo-email'));
});

test('isScheduledEmailJob=false: normal flow does not force brevo-email injection', async () => {
  const tools = {
    'web-fetch': async () => 'some data',
  };

  const loop = new ToolLoop(registry(tools), { maxSteps: 3, isScheduledEmailJob: false });
  const webFetchCall = JSON.stringify({
    type: 'tool_call',
    tool: 'web-fetch',
    input: { query: 'test' },
  });
  const finalResponse = JSON.stringify({ type: 'final_response', content: 'Done.' });

  const result = await loop.run(
    provider([webFetchCall, finalResponse]),
    'mock',
    [createMessage({ role: 'user', content: 'Get some data' })],
    'You are an assistant.'
  );

  assert.equal(result.finalText, 'Done.');
  assert.ok(!result.toolsUsed.includes('brevo-email'));
});

test('direct email request: final draft after web-fetch is converted to brevo-email execution', async () => {
  let webFetchCallCount = 0;
  let brevoCallCount = 0;

  const tools = {
    'web-fetch': async () => {
      webFetchCallCount++;
      return 'Arsenal menang dan memperbarui skuad hari ini.';
    },
    'brevo-email': async (input) => {
      brevoCallCount++;
      assert.equal(input.subject, 'Berita Arsenal Terbaru');
      assert.match(input.htmlContent, /Arsenal/i);
      return JSON.stringify({ ok: true, messageId: 'direct-123', recipientEmail: 'user@example.test' });
    },
  };

  const webFetchCall = JSON.stringify({
    type: 'tool_call',
    tool: 'web-fetch',
    input: { query: 'berita arsenal terbaru' },
  });
  const draftFinal = JSON.stringify({
    type: 'final_response',
    content: [
      'Subject: Berita Arsenal Terbaru',
      '',
      'Isi Email (HTML):',
      '<h1>Berita Arsenal</h1><p>Arsenal menang dan memperbarui skuad hari ini.</p>',
    ].join('\n'),
  });

  const loop = new ToolLoop(registry(tools), { maxSteps: 3 });
  const result = await loop.run(
    provider([webFetchCall, draftFinal]),
    'mock',
    [createMessage({ role: 'user', content: 'kirim berita arsenal terupdate ke email saya' })],
    'You are an assistant.'
  );

  assert.equal(webFetchCallCount, 1);
  assert.equal(brevoCallCount, 1);
  assert.ok(result.toolsUsed.includes('web-fetch'));
  assert.ok(result.toolsUsed.includes('brevo-email'));
  assert.match(result.finalText, /Email berhasil dikirim/i);
});

test('direct email request: explicit recipient is preserved in brevo-email input', async () => {
  let brevoInput;
  const tools = {
    'brevo-email': async (input) => {
      brevoInput = input;
      return JSON.stringify({ ok: true, messageId: 'recipient-123', recipientEmail: input.recipientEmail });
    },
  };
  const brevoCallWithoutRecipient = JSON.stringify({
    type: 'tool_call',
    tool: 'brevo-email',
    input: { subject: 'Report', htmlContent: '<p>Report</p>' },
  });

  const loop = new ToolLoop(registry(tools), { maxSteps: 2 });
  const result = await loop.run(
    provider([brevoCallWithoutRecipient]),
    'mock',
    [createMessage({ role: 'user', content: 'buat report dan kirim ke email boss@gmail.com' })],
    'You are an assistant.'
  );

  assert.equal(brevoInput.recipientEmail, 'boss@gmail.com');
  assert.match(result.finalText, /boss@gmail\.com/);
});

test('email intent helpers distinguish send requests from draft requests', () => {
  assert.equal(userRequiresEmail('kirim berita arsenal terupdate ke email saya'), true);
  assert.equal(userRequiresEmail('send latest AI news to my email'), true);
  assert.equal(userRequiresEmail('buat draft email untuk client'), false);
  assert.equal(extractRecipientEmail('kirim ke boss@gmail.com'), 'boss@gmail.com');
  assert.equal(extractRecipientEmail('kirim ke email@example.com'), undefined);
  assert.deepEqual(
    extractEmailPayloadFromDraft('Subject: Halo\n\nIsi Email (HTML):\n<p>Hai</p>'),
    { subject: 'Halo', htmlContent: '<p>Hai</p>' }
  );
});
