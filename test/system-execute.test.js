const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.APP_DATA_DIR = path.resolve(__dirname, '..', '.data-test-system-execute');
process.env.SYSTEM_EXECUTE_POLICY = 'risk-based';
process.env.SYSTEM_EXECUTE_ALLOW_ARBITRARY = 'true';
process.env.SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE = 'true';

const {
  approveCommand,
  classifyCommandRisk,
  detectShell,
  isDangerousCommand,
  rejectCommand,
  runSystemExecute,
} = require('../dist/tools/system-execute');

function extractApprovalId(content) {
  const match = content.match(/cmd_[a-f0-9]{8}/i);
  assert.ok(match, `expected approval id in content: ${content}`);
  return match[0];
}

test('safe command executes immediately', async () => {
  assert.equal(classifyCommandRisk('echo hello').risk, 'safe');
  const result = await runSystemExecute({ command: 'echo hello' });
  assert.equal(result.risk.risk, 'safe');
  assert.match(result.content, /Risk: safe/);
  assert.match(result.content, /Approval: not required/);
  assert.notEqual(result.exitCode, null);
});

test('unknown harmless command is warning and is not blocked by allowlist', async () => {
  const result = await runSystemExecute({ command: 'some-custom-cli --version' });
  assert.equal(result.risk.risk, 'warning');
  assert.match(result.content, /Risk: warning/);
  assert.doesNotMatch(result.content, /allowlist|not permitted/i);
  assert.notEqual(result.exitCode, null);
});

test('dangerous recursive delete command requires approval', async () => {
  const result = await runSystemExecute({ command: 'rm -rf /' });
  assert.equal(result.ok, false);
  assert.equal(result.risk.risk, 'dangerous');
  assert.match(result.content, /requires approval/i);
  assert.match(result.content, /approve command cmd_/i);
});

test('dangerous Windows restart command requires approval', async () => {
  const result = await runSystemExecute({ command: 'shutdown /r /t 0' });
  assert.equal(result.ok, false);
  assert.equal(result.risk.risk, 'dangerous');
  assert.match(result.content, /requires approval/i);
});

test('approved dangerous command executes after approval', async () => {
  const command = 'node -e "console.log(\'shutdown approval-ok\')"';
  const blocked = await runSystemExecute({ command });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.risk.risk, 'dangerous');
  const approvalId = extractApprovalId(blocked.content);

  const executed = await approveCommand(approvalId);
  assert.equal(executed.risk.risk, 'dangerous');
  assert.match(executed.content, /Approval: approved/);
  assert.match(executed.content, /shutdown approval-ok/);
});

test('rejected dangerous command is not executed', async () => {
  const blocked = await runSystemExecute({ command: 'node -e "console.log(\'shutdown reject-me\')"' });
  const approvalId = extractApprovalId(blocked.content);
  const rejected = await rejectCommand(approvalId);
  assert.equal(rejected.ok, true);
  assert.match(rejected.content, /rejected/i);
});

test('expired approval is rejected', async () => {
  const previous = process.env.SYSTEM_EXECUTE_APPROVAL_TTL_MS;
  process.env.SYSTEM_EXECUTE_APPROVAL_TTL_MS = '1';
  try {
    const blocked = await runSystemExecute({ command: 'node -e "console.log(\'shutdown expired\')"' });
    const approvalId = extractApprovalId(blocked.content);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await approveCommand(approvalId);
    assert.equal(result.ok, false);
    assert.match(result.content, /expired/i);
  } finally {
    if (previous === undefined) delete process.env.SYSTEM_EXECUTE_APPROVAL_TTL_MS;
    else process.env.SYSTEM_EXECUTE_APPROVAL_TTL_MS = previous;
  }
});

test('non-dangerous command is not blocked by dangerous guard', async () => {
  assert.equal(isDangerousCommand('ls -la'), false);
  const result = await runSystemExecute({ command: 'ls -la' });
  assert.doesNotMatch(result.content, /requires approval/i);
});

test('risk classifier does not treat echoed dangerous words as dangerous', () => {
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
