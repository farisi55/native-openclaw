const test = require('node:test');
const assert = require('node:assert/strict');

const { planCommand } = require('../dist/tools/command-planner');

test('Windows command plan uses PowerShell syntax', async () => {
  const result = await planCommand({
    intent: 'list 10 largest files in downloads',
    platform: 'win32',
    shell: 'powershell.exe',
  });

  assert.match(result.command, /Get-ChildItem/);
  assert.match(result.command, /Sort-Object Length/);
  assert.equal(result.isDangerous, false);
});

test('Linux command plan uses bash-compatible syntax', async () => {
  const result = await planCommand({
    intent: 'list 10 largest files in downloads',
    platform: 'linux',
    shell: '/bin/bash',
  });

  assert.match(result.command, /^find ~\/Downloads/);
  assert.match(result.command, /head -10/);
  assert.equal(result.isDangerous, false);
});

test('dangerous command intent is flagged', async () => {
  const result = await planCommand({
    intent: 'rm -rf /tmp/test',
    platform: 'linux',
    shell: '/bin/bash',
  });

  assert.equal(result.command, 'rm -rf /tmp/test');
  assert.equal(result.isDangerous, true);
});
