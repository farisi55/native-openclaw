const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  sendPendingRestartNotificationIfAny,
  sendRestartNotifications,
  writeRestartPendingNotification,
} = require('../dist/runtime/restart-notifier');
const { LifecycleManager } = require('../dist/runtime/lifecycle-manager');

const ENV_KEYS = [
  'APP_DATA_DIR',
  'RESTART_NOTIFICATION_ENABLED',
  'RESTART_NOTIFY_TELEGRAM',
  'RESTART_NOTIFY_EMAIL',
  'RESTART_NOTIFICATION_TIMEOUT_MS',
  'RESTART_TELEGRAM_CHAT_ID',
  'RESTART_TELEGRAM_USE_DEFAULT_CHAT',
  'RESTART_EMAIL_RECIPIENT',
  'RESTART_EMAIL_USE_BREVO_DEFAULTS',
  'RESTART_NOTIFY_AFTER_START',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'BREVO_RECIPIENT_EMAIL',
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function baseInput(overrides = {}) {
  return {
    runId: 'heal-test-123',
    runType: 'self-healing',
    status: 'passed',
    restartRequired: true,
    autoRestartScheduled: true,
    delayMs: 1500,
    exitCode: 42,
    reason: 'self-healing changed config/source/tool files',
    changedFiles: ['src/config/logging.ts', 'src/services/telegram/polling.service.ts'],
    summary: 'Self-healing passed after 1 loop(s). Auto restart scheduled in 1.5s.',
    timestamp: '2026-06-04T00:00:00.000Z',
    ...overrides,
  };
}

test.afterEach(() => {
  restoreEnv();
  process.exitCode = 0;
});

test('sendRestartNotifications skips when disabled', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'false';
  let telegramCalls = 0;
  let emailCalls = 0;

  const result = await sendRestartNotifications(baseInput(), {
    sendTelegram: async () => {
      telegramCalls += 1;
    },
    sendEmail: async () => {
      emailCalls += 1;
      return { ok: true, content: 'sent' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(telegramCalls, 0);
  assert.equal(emailCalls, 0);
});

test('Telegram restart notification includes run details and changed files', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'false';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_CHAT_ID = '12345';

  let captured = null;
  const result = await sendRestartNotifications(baseInput(), {
    sendTelegram: async (input) => {
      captured = input;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.telegram.attempted, true);
  assert.equal(captured.chatId, '12345');
  assert.match(captured.text, /heal-test-123/);
  assert.match(captured.text, /self-healing/);
  assert.match(captured.text, /Exit code: 42/);
  assert.match(captured.text, /src\/config\/logging\.ts/);
});

test('email restart notification uses Brevo recipient payload', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'false';
  process.env.RESTART_NOTIFY_EMAIL = 'true';
  process.env.RESTART_EMAIL_RECIPIENT = 'ops@example.com';

  let captured = null;
  const result = await sendRestartNotifications(baseInput({ runType: 'self-upgrade' }), {
    sendEmail: async (input) => {
      captured = input;
      return { ok: true, content: 'sent' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.email.attempted, true);
  assert.equal(captured.recipientEmail, 'ops@example.com');
  assert.match(captured.subject, /Self-Upgrade/);
  assert.match(captured.htmlContent, /heal-test-123/);
  assert.match(captured.htmlContent, /src\/config\/logging\.ts/);
});

test('Telegram failure does not prevent email attempt', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_CHAT_ID = '12345';
  process.env.RESTART_EMAIL_RECIPIENT = 'ops@example.com';
  let emailCalls = 0;

  const result = await sendRestartNotifications(baseInput(), {
    sendTelegram: async () => {
      throw new Error('telegram down');
    },
    sendEmail: async () => {
      emailCalls += 1;
      return { ok: true, content: 'sent' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.telegram.ok, false);
  assert.equal(result.email.ok, true);
  assert.equal(emailCalls, 1);
  assert.match(result.errors.join('\n'), /telegram down/);
});

test('email failure does not prevent Telegram attempt', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_CHAT_ID = '12345';
  process.env.RESTART_EMAIL_RECIPIENT = 'ops@example.com';
  let telegramCalls = 0;

  const result = await sendRestartNotifications(baseInput(), {
    sendTelegram: async () => {
      telegramCalls += 1;
    },
    sendEmail: async () => ({ ok: false, error: 'brevo down', content: 'not sent' }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.telegram.ok, true);
  assert.equal(result.email.ok, false);
  assert.equal(telegramCalls, 1);
  assert.match(result.errors.join('\n'), /brevo down/);
});

test('notification timeout returns without hanging', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'false';
  process.env.RESTART_NOTIFICATION_TIMEOUT_MS = '5';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_CHAT_ID = '12345';

  const started = Date.now();
  const result = await sendRestartNotifications(baseInput(), {
    sendTelegram: async () => new Promise(() => undefined),
  });

  assert.equal(result.ok, false);
  assert(Date.now() - started < 1000);
  assert.match(result.errors.join('\n'), /timed out/i);
});

test('LifecycleManager sends notification before exit code 42', async () => {
  const order = [];
  const callbacks = [];
  const manager = new LifecycleManager({
    isTestRuntime: false,
    delayMs: 1,
    exitCode: 42,
    setTimeoutFn: (callback) => {
      callbacks.push(callback);
      order.push('scheduled');
      return 0;
    },
    writePendingRestartFn: async () => {
      order.push('pending');
    },
    notifyRestartFn: async (input) => {
      order.push(`notify:${input.runId}`);
      return { ok: true, errors: [] };
    },
    exitFn: (code) => {
      order.push(`exit:${code}`);
    },
  });

  manager.requestRestart({
    reason: 'source changed',
    runId: 'upgrade-1',
    runType: 'self-upgrade',
    changedFiles: ['src/tools/new-tool.ts'],
    summary: 'passed',
  });

  assert.equal(callbacks.length, 1);
  await callbacks[0]();
  process.exitCode = 0;
  assert.deepEqual(order, ['scheduled', 'pending', 'notify:upgrade-1', 'exit:42']);
});

test('missing Telegram chat id and email recipient are skipped without crash', async () => {
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'true';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_USE_DEFAULT_CHAT = 'false';
  process.env.RESTART_EMAIL_USE_BREVO_DEFAULTS = 'false';
  delete process.env.RESTART_TELEGRAM_CHAT_ID;
  delete process.env.RESTART_EMAIL_RECIPIENT;

  const result = await sendRestartNotifications(baseInput());
  assert.equal(result.ok, true);
  assert.equal(result.telegram.attempted, false);
  assert.equal(result.email.attempted, false);
  assert.match(result.telegram.error, /chat id/i);
  assert.match(result.email.error, /recipient/i);
});

test('pending restart marker sends after-start notification and is removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'restart-notifier-'));
  process.env.APP_DATA_DIR = dir;
  process.env.RESTART_NOTIFICATION_ENABLED = 'true';
  process.env.RESTART_NOTIFY_AFTER_START = 'true';
  process.env.RESTART_NOTIFY_TELEGRAM = 'true';
  process.env.RESTART_NOTIFY_EMAIL = 'false';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESTART_TELEGRAM_CHAT_ID = '12345';

  try {
    await writeRestartPendingNotification(baseInput({ runId: 'heal-pending' }));
    const pendingPath = join(dir, 'restart-pending.json');
    assert.match(await readFile(pendingPath, 'utf-8'), /heal-pending/);

    let capturedText = '';
    const result = await sendPendingRestartNotificationIfAny({
      sendTelegram: async (input) => {
        capturedText = input.text;
      },
    });

    assert.equal(result.ok, true);
    assert.match(capturedText, /restarted successfully/);
    assert.equal(existsSync(pendingPath), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
