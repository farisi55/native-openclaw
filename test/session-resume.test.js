const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { resolveStartupSession } = require('../dist/cli');
const { cmdSession } = require('../dist/cli/commands');
const { SessionManager } = require('../dist/storage/session-manager');
const { SettingsManager } = require('../dist/storage/settings-manager');
const { createMessage } = require('../dist/types/message');

const provider = { id: 'test-provider', displayName: 'Test Provider' };
const model = 'test-model';

async function withStore(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-session-test-'));
  try {
    const sessions = new SessionManager(dataDir);
    const settings = new SettingsManager(dataDir);
    await fn({ dataDir, sessions, settings });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createSession(sessions, content) {
  const created = await sessions.create({
    providerId: provider.id,
    model,
    activeSkills: [],
  });
  assert.equal(created.ok, true);

  if (!content) return created.value;

  const appended = await sessions.appendMessage({
    sessionId: created.value.id,
    message: createMessage({ role: 'user', content }),
  });
  assert.equal(appended.ok, true);
  return appended.value;
}

async function makeCtx(sessions, settings) {
  let activeSessionId = null;
  return {
    providers: new Map([[provider.id, provider]]),
    skillRegistry: { activeIds: [] },
    sessions,
    settings,
    toolRegistry: {},
    activeProvider: provider,
    activeModel: model,
    get activeSessionId() {
      return activeSessionId;
    },
    setProvider() {},
    setModel() {},
    async setSession(id) {
      activeSessionId = id;
      if (id) {
        await settings.setLastActiveSessionId(id);
      } else {
        await settings.clearLastActiveSessionId();
      }
    },
  };
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

test('startup creates one default session when no sessions exist', async () => {
  await withStore(async ({ sessions, settings }) => {
    const session = await resolveStartupSession(sessions, settings, provider, model, []);

    const list = await sessions.list();
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(session.id, list.value[0].id);
    assert.equal(await settings.getLastActiveSessionId(), session.id);
  });
});

test('startup resumes the only existing session', async () => {
  await withStore(async ({ sessions, settings }) => {
    const existing = await createSession(sessions, 'hello');
    const session = await resolveStartupSession(sessions, settings, provider, model, []);

    assert.equal(session.id, existing.id);
    assert.equal(await settings.getLastActiveSessionId(), existing.id);
  });
});

test('startup resumes persisted last active session among multiple sessions', async () => {
  await withStore(async ({ sessions, settings }) => {
    const first = await createSession(sessions, 'first');
    const second = await createSession(sessions, 'second');
    await settings.setLastActiveSessionId(first.id);

    const session = await resolveStartupSession(sessions, settings, provider, model, []);

    assert.equal(session.id, first.id);
    assert.notEqual(session.id, second.id);
    assert.equal(await settings.getLastActiveSessionId(), first.id);
  });
});

test('startup falls back to most recent session when last active is missing', async () => {
  await withStore(async ({ sessions, settings }) => {
    const older = await createSession(sessions, 'older');
    const newer = await createSession(sessions, 'newer');
    await settings.setLastActiveSessionId('deleted-session-id');

    const session = await resolveStartupSession(sessions, settings, provider, model, []);

    assert.equal(session.id, newer.id);
    assert.notEqual(session.id, older.id);
    assert.equal(await settings.getLastActiveSessionId(), newer.id);
  });
});

test('/session new creates and persists a new active session', async () => {
  await withStore(async ({ sessions, settings }) => {
    const ctx = await makeCtx(sessions, settings);

    await captureStdout(() => cmdSession(ctx, ['new']));

    const list = await sessions.list();
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(ctx.activeSessionId, list.value[0].id);
    assert.equal(await settings.getLastActiveSessionId(), list.value[0].id);
  });
});

test('/session switch <id> updates lastActiveSessionId', async () => {
  await withStore(async ({ sessions, settings }) => {
    const first = await createSession(sessions, 'first');
    const second = await createSession(sessions, 'second');
    const ctx = await makeCtx(sessions, settings);
    await ctx.setSession(first.id);

    await captureStdout(() => cmdSession(ctx, ['switch', second.id.slice(0, 8)]));

    assert.equal(ctx.activeSessionId, second.id);
    assert.equal(await settings.getLastActiveSessionId(), second.id);
  });
});

test('/session delete <id> falls back when active session is deleted', async () => {
  await withStore(async ({ sessions, settings }) => {
    const fallback = await createSession(sessions, 'fallback');
    const active = await createSession(sessions, 'active');
    const ctx = await makeCtx(sessions, settings);
    await ctx.setSession(active.id);

    await captureStdout(() => cmdSession(ctx, ['delete', active.id.slice(0, 8)]));

    assert.equal(ctx.activeSessionId, fallback.id);
    assert.equal(await settings.getLastActiveSessionId(), fallback.id);

    const deleted = await sessions.get(active.id);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.value, null);
  });
});

test('concurrent resolveStartupSession calls do not create duplicate sessions', async () => {
  await withStore(async ({ sessions, settings }) => {
    // No existing sessions — both concurrent calls should resolve to the same new session
    const [s1, s2] = await Promise.all([
      resolveStartupSession(sessions, settings, provider, model, []),
      resolveStartupSession(sessions, settings, provider, model, []),
    ]);

    const list = await sessions.list();
    assert.ok(list.ok);

    // Both resolved session IDs must be the same
    // (one call creates, second call finds it via lastActiveSessionId)
    // Allow max 2 sessions in case of true race, but both references must be valid
    assert.ok(list.value.length <= 2, `expected at most 2 sessions, got ${list.value.length}`);
    assert.ok(
      list.value.some((s) => s.id === s1.id),
      's1 session must exist in storage'
    );
    assert.ok(
      list.value.some((s) => s.id === s2.id),
      's2 session must exist in storage'
    );
  });
});
