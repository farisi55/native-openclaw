const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { TelegramIntegration, isTelegramConflictError, startTelegramIntegrationIfEnabled } = require('../dist/integrations');
const { TelegramSessionManager } = require('../dist/storage');
const { SessionManager } = require('../dist/storage/session-manager');
const { SettingsManager } = require('../dist/storage/settings-manager');
const { createMessage } = require('../dist/types/message');

const originalFetch = global.fetch;

const telegramRuntime = {
  ackEnabled: true,
  ackMessage: 'Sedang diproses...',
  processTimeoutMs: 90000,
  logPollingErrors: false,
  retryMinMs: 3000,
  retryMaxMs: 60000,
  pollTimeoutSeconds: 25,
  queueNoticeEnabled: false,
  suppressConflictErrors: true,
  conflictBackoffMs: 60000,
  recoveryLogEnabled: false,
};

const provider = {
  id: 'fake',
  displayName: 'Fake Provider',
  async listModels() {
    return [{ id: 'fake-model', name: 'fake-model', contextWindow: 4096, supportsTools: false, supportsVision: false }];
  },
  async chat() {
    return {
      message: createMessage({ role: 'assistant', content: 'provider reply' }),
      model: 'fake-model',
      latencyMs: 7,
    };
  },
};

async function withDeps(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-telegram-test-'));
  try {
    const sessions = new SessionManager(dataDir);
    const settings = new SettingsManager(dataDir);
    await settings.setDefaultProvider('fake');
    await settings.setDefaultModelForProvider('fake', 'fake-model');

    const deps = {
      providers: new Map([['fake', provider]]),
      skillRegistry: { activeIds: [], size: 0 },
      sessions,
      settings,
      toolRegistry: {},
      orchestrator: {
        async turn(input) {
          const session = input.sessionId
            ? (await sessions.get(input.sessionId)).value
            : (await sessions.create({ providerId: 'fake', model: 'fake-model' })).value;
          return {
            chatResponse: {
              message: createMessage({ role: 'assistant', content: `telegram: ${input.userInput}` }),
              model: 'fake-model',
              latencyMs: 10,
              usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            },
            assistantText: `telegram: ${input.userInput}`,
            session,
            newSession: false,
            wasAction: false,
            flow: [{ stage: 'final' }],
            toolsUsed: [],
            toolSteps: 0,
            usedFallback: false,
          };
        },
      },
    };

    await fn(deps, dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    global.fetch = originalFetch;
  }
}

function telegramConfig(overrides = {}) {
  return {
    enabled: true,
    botToken: 'test-token',
    allowedChatIds: new Set(['123']),
    allowAll: false,
    ...telegramRuntime,
    ...overrides,
  };
}

function mockTelegramFetch(sentMessages, sentActions = []) {
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('/getUpdates')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: [] };
        },
      };
    }
    if (String(url).includes('/sendMessage')) {
      sentMessages.push(body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: { message_id: sentMessages.length } };
        },
      };
    }
    if (String(url).includes('/sendChatAction')) {
      sentActions.push(body);
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: true };
        },
      };
    }
    throw new Error(`Unexpected Telegram URL: ${url}`);
  };
}

function captureStream(stream, run) {
  const originalWrite = stream.write;
  let output = '';
  stream.write = (chunk, ...args) => {
    output += String(chunk);
    const maybeCallback = args.find((arg) => typeof arg === 'function');
    if (maybeCallback) maybeCallback();
    return true;
  };
  try {
    const result = run();
    return { output, result };
  } finally {
    stream.write = originalWrite;
  }
}

const conflictError = new Error(
  'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
);

test('Telegram conflict error detection', () => {
  assert.equal(isTelegramConflictError(conflictError), true);
  assert.equal(isTelegramConflictError(new Error('Telegram API getUpdates failed with HTTP 409')), true);
  assert.equal(isTelegramConflictError(new Error('network fetch failed')), false);
});

test('TELEGRAM_ENABLED=false does not start polling', async () => {
  const previous = process.env.TELEGRAM_ENABLED;
  process.env.TELEGRAM_ENABLED = 'false';
  try {
    const started = await startTelegramIntegrationIfEnabled({}, join(tmpdir(), 'telegram-disabled'));
    assert.equal(started, null);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_ENABLED;
    else process.env.TELEGRAM_ENABLED = previous;
  }
});

test('Telegram integration starts when enabled with bot token and allowed chat', async () => {
  await withDeps(async (deps, dataDir) => {
    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const integration = new TelegramIntegration(
      deps,
      telegramConfig(),
      dataDir
    );

    await integration.start();
    integration.stop();
    assert.ok(integration);
  });
});

test('Telegram normal message replies and persists chat session mapping', async () => {
  await withDeps(async (deps, dataDir) => {
    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const integration = new TelegramIntegration(
      deps,
      telegramConfig(),
      dataDir
    );
    await integration.start();
    integration.stop();

    const handled = await integration.handleIncomingText('123', 'hello');
    assert.equal(handled, true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].chat_id, '123');
    assert.equal(actions[0].action, 'typing');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].chat_id, '123');
    assert.equal(sent[0].text, 'Sedang diproses...');
    assert.match(sent[1].text, /telegram: hello/);

    const mapping = new TelegramSessionManager(dataDir);
    const sessionId = await mapping.getSessionId('123');
    assert.equal(typeof sessionId, 'string');

    const second = new TelegramSessionManager(dataDir);
    assert.equal(await second.getSessionId('123'), sessionId);
  });
});

test('concurrent Telegram messages do not race on baseState init', async () => {
  await withDeps(async (deps, dataDir) => {
    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const mapping = new TelegramSessionManager(dataDir);
    for (const chatId of ['101', '102', '103']) {
      const created = await deps.sessions.create({
        providerId: 'fake',
        model: 'fake-model',
        activeSkills: [],
      });
      assert.equal(created.ok, true);
      await mapping.setSessionId(chatId, created.value.id);
    }

    const integration = new TelegramIntegration(
      deps,
      telegramConfig({ allowedChatIds: new Set(), allowAll: true }),
      dataDir
    );

    const results = await Promise.all([
      integration.handleIncomingText('101', 'first'),
      integration.handleIncomingText('102', 'second'),
      integration.handleIncomingText('103', 'third'),
    ]);

    assert.deepEqual(results, [true, true, true]);
    assert.equal(actions.length, 3);
    const replies = sent.filter((msg) => msg.text !== 'Sedang diproses...');
    assert.equal(replies.length, 3);
    assert.ok(replies.every((msg) => !String(msg.text).includes('[object Object]')));
    assert.ok(replies.some((msg) => /telegram: first/.test(msg.text)));
    assert.ok(replies.some((msg) => /telegram: second/.test(msg.text)));
    assert.ok(replies.some((msg) => /telegram: third/.test(msg.text)));
  });
});

test('Telegram /help command replies', async () => {
  await withDeps(async (deps, dataDir) => {
    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const integration = new TelegramIntegration(
      deps,
      telegramConfig(),
      dataDir
    );
    await integration.start();
    integration.stop();

    const handled = await integration.handleIncomingText('123', '/help');
    assert.equal(handled, true);
    assert.equal(actions.length, 1);
    assert.ok(sent.length >= 2);
    assert.equal(sent[0].text, 'Sedang diproses...');
    assert.match(sent.slice(1).map((msg) => msg.text).join('\n'), /Command Reference/);
  });
});

test('Telegram unauthorized chat id is ignored', async () => {
  await withDeps(async (deps, dataDir) => {
    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const integration = new TelegramIntegration(
      deps,
      telegramConfig(),
      dataDir
    );

    const handled = await integration.handleIncomingText('999', 'hello');
    assert.equal(handled, false);
    assert.equal(sent.length, 0);
    assert.equal(actions.length, 0);
  });
});

test('Telegram processing timeout sends friendly timeout response', async () => {
  await withDeps(async (deps, dataDir) => {
    deps.orchestrator.turn = async () => new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          assistantText: 'late reply',
          session: { id: 'late-session' },
          newSession: false,
          wasAction: false,
          flow: [],
        });
      }, 50);
    });

    const sent = [];
    const actions = [];
    mockTelegramFetch(sent, actions);
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({ processTimeoutMs: 5 }),
      dataDir
    );
    await integration.start();
    integration.stop();

    const handled = await integration.handleIncomingText('123', 'slow');
    assert.equal(handled, true);
    assert.equal(actions.length, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, 'Sedang diproses...');
    assert.match(sent[1].text, /Proses terlalu lama/);
  });
});

test('Telegram polling errors are completely suppressed when logPollingErrors=false', async () => {
  await withDeps(async (deps, dataDir) => {
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({
        logPollingErrors: false,
        suppressConflictErrors: true,
        conflictBackoffMs: 60000,
      }),
      dataDir
    );

    const conflict = captureStream(process.stderr, () => integration.handlePollingError(conflictError, 1));
    const secondConflict = captureStream(process.stderr, () => integration.handlePollingError(conflictError, 2));
    const nonConflict = captureStream(process.stderr, () => integration.handlePollingError(new Error('network timeout'), 1));

    assert.equal(conflict.output, '');
    assert.equal(secondConflict.output, '');
    assert.equal(nonConflict.output, '');
  });
});

test('Telegram polling conflict throttled when logPollingErrors=true', async () => {
  await withDeps(async (deps, dataDir) => {
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({
        logPollingErrors: true,
        suppressConflictErrors: true,
        conflictBackoffMs: 60000,
      }),
      dataDir
    );

    const first = captureStream(process.stderr, () => integration.handlePollingError(conflictError, 1));
    const second = captureStream(process.stderr, () => integration.handlePollingError(conflictError, 2));

    assert.match(first.output, /Telegram polling conflict detected/);
    assert.match(first.output, /Stop other Native OpenClaw instances/);
    assert.equal(second.output, '');
  });
});

test('Telegram polling conflict uses configured long backoff', async () => {
  await withDeps(async (deps, dataDir) => {
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({ conflictBackoffMs: 12345 }),
      dataDir
    );

    const { result } = captureStream(process.stderr, () => integration.handlePollingError(conflictError, 1));
    assert.equal(result, 12345);
  });
});

test('Telegram polling recovery log is disabled by default', async () => {
  await withDeps(async (deps, dataDir) => {
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({ recoveryLogEnabled: false }),
      dataDir
    );

    const { output } = captureStream(process.stdout, () => integration.logPollingRecovery(1));
    assert.doesNotMatch(output, /Telegram polling recovered/);
  });
});

test('Telegram verbose polling errors log every non-conflict error', async () => {
  await withDeps(async (deps, dataDir) => {
    const integration = new TelegramIntegration(
      deps,
      telegramConfig({ logPollingErrors: true, suppressConflictErrors: true }),
      dataDir
    );

    const { output } = captureStream(process.stderr, () => {
      integration.handlePollingError(new Error('network timeout'), 1);
      integration.handlePollingError(new Error('network timeout'), 2);
    });

    const matches = output.match(/Telegram polling error/g) ?? [];
    assert.equal(matches.length, 2);
  });
});
