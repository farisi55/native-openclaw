const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { SessionManager } = require('../../dist/storage/session-manager');
const { SettingsManager } = require('../../dist/storage/settings-manager');
const { MemoryManager } = require('../../dist/storage/memory-manager');
const { createMessage } = require('../../dist/types/message');
const { handleAction } = require('../../dist/agents/action-handler');

const ENV_KEYS = [
  'WORKSPACE_DIR',
  'WORKSPACE_ALLOW_OUTSIDE_PATHS',
  'WORKSPACE_MEMORY_ENABLED',
  'WORKSPACE_DAILY_MEMORY_ENABLED',
  'SYSTEM_EXECUTE_DEFAULT_CWD',
  'TOOLS_DIR',
];

function saveEnv(keys = ENV_KEYS) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withTempWorkspace(fn, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-workspace-qa-'));
  const snapshot = saveEnv();
  process.env.WORKSPACE_DIR = root;
  process.env.WORKSPACE_ALLOW_OUTSIDE_PATHS = 'false';
  process.env.WORKSPACE_MEMORY_ENABLED = 'true';
  process.env.WORKSPACE_DAILY_MEMORY_ENABLED = 'true';
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  try {
    await fn(root);
  } finally {
    restoreEnv(snapshot);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function withTempDirs(fn) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openclaw-workspace-qa-'));
  const dataDir = await mkdtemp(join(tmpdir(), 'openclaw-data-qa-'));
  const snapshot = saveEnv();
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.WORKSPACE_ALLOW_OUTSIDE_PATHS = 'false';
  process.env.WORKSPACE_MEMORY_ENABLED = 'true';
  process.env.WORKSPACE_DAILY_MEMORY_ENABLED = 'true';

  try {
    await fn({ workspaceRoot, dataDir });
  } finally {
    restoreEnv(snapshot);
    await rm(workspaceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    await rm(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    process.stdout.write = originalWrite;
  }
}

function emptyToolRegistry() {
  return {
    size: 0,
    listTools() {
      return [];
    },
    getTool() {
      return undefined;
    },
    has() {
      return false;
    },
    buildToolsBlock() {
      return null;
    },
  };
}

function mockSkillRegistry() {
  return {
    activeIds: [],
    size: 0,
    activeSkills() {
      return [];
    },
    all() {
      return [];
    },
    has() {
      return false;
    },
  };
}

function mockProvider(reply = 'provider reply') {
  return {
    id: 'fake',
    displayName: 'Fake Provider',
    async listModels() {
      return [{ id: 'fake-model', name: 'fake-model', contextWindow: 4096, supportsTools: false, supportsVision: false }];
    },
    async chat() {
      return {
        message: createMessage({ role: 'assistant', content: reply }),
        model: 'fake-model',
        latencyMs: 5,
      };
    },
  };
}

async function createApiDeps(dataDir, options = {}) {
  const sessions = new SessionManager(dataDir);
  const settings = new SettingsManager(dataDir);
  const memory = new MemoryManager(dataDir);
  const provider = options.provider ?? mockProvider();
  const skillRegistry = options.skillRegistry ?? mockSkillRegistry();
  const toolRegistry = options.toolRegistry ?? emptyToolRegistry();

  await settings.setDefaultProvider(provider.id);
  await settings.setDefaultModelForProvider(provider.id, 'fake-model');

  const deps = {
    providers: new Map([[provider.id, provider]]),
    skillRegistry,
    sessions,
    settings,
    toolRegistry,
    orchestrator: {
      async turn(input) {
        const existing = input.sessionId ? await sessions.get(input.sessionId) : null;
        const session = existing?.ok && existing.value
          ? existing.value
          : (await sessions.create({ providerId: provider.id, model: 'fake-model', activeSkills: [] })).value;

        const action = await handleAction(input.userInput, {
          skillRegistry,
          sessions,
          skillsDir: resolve(process.cwd(), 'skills'),
          activeSessionId: session.id,
          onSessionCleared() {},
        });

        const assistantText = action.handled
          ? action.response ?? ''
          : `echo: ${input.userInput}`;

        return {
          chatResponse: {
            message: createMessage({ role: 'assistant', content: assistantText }),
            model: 'fake-model',
            latencyMs: 7,
          },
          assistantText,
          session,
          newSession: false,
          wasAction: action.handled,
          flow: [{ stage: 'final', type: action.handled ? 'action' : 'mock' }],
          toolsUsed: [],
          toolSteps: 0,
          usedFallback: false,
        };
      },
    },
  };

  return { deps, sessions, settings, memory, provider, skillRegistry, toolRegistry };
}

function cliContext(overrides = {}) {
  const provider = overrides.provider ?? mockProvider();
  return {
    providers: new Map([[provider.id, provider]]),
    skillRegistry: overrides.skillRegistry ?? mockSkillRegistry(),
    sessions: overrides.sessions ?? {},
    settings: overrides.settings ?? {},
    toolRegistry: overrides.toolRegistry ?? emptyToolRegistry(),
    activeProvider: provider,
    activeModel: 'fake-model',
    activeSessionId: null,
    setProvider() {},
    setModel() {},
    async setSession() {},
    ...overrides,
  };
}

function mockTelegramFetch(sentMessages, sentActions = []) {
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
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
    if (String(url).includes('/getUpdates')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, result: [] };
        },
      };
    }
    throw new Error(`Unexpected Telegram URL: ${url}`);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

module.exports = {
  captureStdout,
  cliContext,
  createApiDeps,
  emptyToolRegistry,
  mockProvider,
  mockSkillRegistry,
  mockTelegramFetch,
  restoreEnv,
  saveEnv,
  withTempDirs,
  withTempWorkspace,
};
