const { spawnSync } = require('node:child_process');

const checks = [
  {
    name: 'default',
    args: [],
    expected: ['openclaw'],
  },
  {
    name: 'browser',
    args: ['--profile', 'browser'],
    expected: ['browser-agent', 'openclaw'],
  },
  {
    name: 'research',
    args: ['--profile', 'research'],
    expected: ['openclaw', 'research-agent'],
  },
  {
    name: 'spreadsheet',
    args: ['--profile', 'spreadsheet'],
    expected: ['openclaw', 'spreadsheet-agent'],
  },
  {
    name: 'external-agents',
    args: ['--profile', 'external-agents'],
    expected: [
      'browser-agent',
      'openclaw',
      'research-agent',
      'spreadsheet-agent',
    ],
  },
];

function serviceList(args) {
  const result = spawnSync(
    process.platform === 'win32' ? 'docker.exe' : 'docker',
    ['compose', ...args, 'config', '--services'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
    }
  );
  if (result.error) {
    throw new Error(`Docker Compose is unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `docker compose ${args.join(' ')} config failed:\n${result.stderr.trim()}`
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .sort();
}

for (const check of checks) {
  const actual = serviceList(check.args);
  const expected = [...check.expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${check.name} profile mismatch. Expected [${expected.join(', ')}], got [${actual.join(', ')}].`
    );
  }
  process.stdout.write(
    `[phase3.5:docker] ${check.name}: ${actual.join(', ')}\n`
  );
}

process.stdout.write('[phase3.5:docker] all profile checks passed\n');
