const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { TelegramIntegration, startTelegramIntegrationIfEnabled } = require('../dist/integrations');
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
    await rm(dataDir, { recursive: true, force: true });
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
    assert.equal(sent.length, 2);
    assert.equal(sent[0].text, 'Sedang diproses...');
    assert.match(sent[1].text, /Command Reference/);
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
