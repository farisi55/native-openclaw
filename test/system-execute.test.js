const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  detectShell,
  isDangerousCommand,
  runSystemExecute,
} = require('../dist/tools/system-execute');

function extractConfirmId(content) {
  const match = content.match(/cmd_[a-f0-9]{8}/i);
  assert.ok(match, `expected confirmId in content: ${content}`);
  return match[0];
}

test('dangerous recursive delete command requires confirmation', async () => {
  const result = await runSystemExecute({ command: 'rm -rf /tmp/test' });
  assert.equal(result.ok, false);
  assert.match(result.content, /berbahaya/i);
});

test('non-dangerous command is not blocked by dangerous guard', async () => {
  assert.equal(isDangerousCommand('ls -la'), false);
  const result = await runSystemExecute({ command: 'ls -la' });
  assert.doesNotMatch(result.content, /berbahaya/i);
});

test('valid confirmation id allows command execution', async () => {
  // Command ini mengandung kata 'shutdown' yang match DANGEROUS_PATTERNS.
  // Test ini memverifikasi flow konfirmasi, bukan memverifikasi command blocking.
  const command = 'echo shutdown-sequence-test';
  const blocked = await runSystemExecute({ command });
  assert.equal(blocked.ok, false);
  const confirmId = extractConfirmId(blocked.content);

  const executed = await runSystemExecute({ command, confirmId });
  assert.doesNotMatch(executed.content, /berbahaya|kedaluwarsa|tidak valid/i);
  assert.match(executed.content, /shutdown-sequence-test/);
});

test('expired confirmation id is rejected', async () => {
  const command = 'echo shutdown-expired';
  const blocked = await runSystemExecute({ command });
  const confirmId = extractConfirmId(blocked.content);
  const originalNow = Date.now;

  try {
    Date.now = () => originalNow() + 6 * 60 * 1000;
    const result = await runSystemExecute({ command, confirmId });
    assert.equal(result.ok, false);
    assert.match(result.content, /kedaluwarsa|tidak valid/i);
  } finally {
    Date.now = originalNow;
  }
});

test('regex tidak memblokir kata serupa yang bukan perintah berbahaya', () => {
  assert.equal(isDangerousCommand('./scripts/restart-app.sh'), false);
  assert.equal(isDangerousCommand('echo reboot-complete'), false);
});

test('detectShell uses COMSPEC on Windows (mocked)', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalComspec = process.env.ComSpec;
  const originalCOMSPEC = process.env.COMSPEC;

  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.ComSpec = 'C:\\Custom\\cmd.exe';
    process.env.COMSPEC = 'C:\\Custom\\cmd.exe';
    assert.equal(detectShell(), 'C:\\Custom\\cmd.exe');
  } finally {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
    if (originalComspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComspec;
    if (originalCOMSPEC === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalCOMSPEC;
  }
});
