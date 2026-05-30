const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.SYSTEM_EXECUTE_POLICY = 'risk-based';
process.env.SYSTEM_EXECUTE_ALLOW_ARBITRARY = 'true';
process.env.SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE = 'true';

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
      return {
        message: createMessage({ role: 'assistant', content: 'final answer' }),
      };
    },
  };
}

test('execute action: dangerous command returns approval request instead of pre-blocking', async () => {
  const provider = providerFor('node -e "console.log(\'shutdown react-test\')"');
  const loop = new ReActLoop(registry());
  await loop.run(provider, 'mock', 'run risky local command', [], 'system');

  assert.ok(
    provider.calls.some((call) => JSON.stringify(call.messages).includes('requires approval')),
    'dangerous command approval request should be injected as observation'
  );
  assert.ok(
    provider.calls.every((call) => !JSON.stringify(call.messages).includes('Command rejected')),
    'react loop should not use the old allowlist rejection path'
  );
});

test('execute action: unknown command is attempted as warning, not allowlist-blocked', async () => {
  const provider = providerFor('some-custom-cli --version');
  const loop = new ReActLoop(registry());
  await loop.run(provider, 'mock', 'run custom cli version', [], 'system');

  assert.ok(
    provider.calls.some((call) => JSON.stringify(call.messages).includes('Risk: warning')),
    'warning command result should be injected as observation'
  );
  assert.ok(
    provider.calls.every((call) => !JSON.stringify(call.messages).includes('not in allowed command list')),
    'unknown commands should not be blocked by allowlist'
  );
});

test('execute action: safe command proceeds normally', async () => {
  const provider = providerFor('echo react-safe');
  const loop = new ReActLoop(registry());
  await loop.run(provider, 'mock', 'print text', [], 'system');

  assert.ok(
    provider.calls.some((call) => JSON.stringify(call.messages).includes('react-safe')),
    'safe command result should be injected as observation'
  );
});
