const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');

const {
  buildOpenCodeArgsPreview,
  classifyOpenCodeError,
  previewOpenCodeArgs,
  runOpenCodeAgent,
  runOpenCodeDoctor,
  validateOpenCodeArgsTemplate,
} = require('../dist/tools/opencode-agent');
const {
  bootstrapOpenCodeAuthFromEnv,
} = require('../dist/tools/opencode-auth');
const {
  detectOpenCode,
  getOpenCodeInstallCommand,
  installOpenCode,
} = require('../dist/tools/opencode-installer');
const {
  findProjectRoot,
  resolveOpenCodeCwd,
} = require('../dist/tools/opencode-cwd-resolver');
const { CodingAgent, PatchApplier, SnapshotManager } = require('../dist/self-healing');

const ENV_KEYS = [
  'OPENCODE_AGENT_ENABLED',
  'OPENCODE_AGENT_COMMAND',
  'OPENCODE_AGENT_CWD',
  'OPENCODE_AGENT_DIRECT_MODE',
  'OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE',
  'OPENCODE_AGENT_TIMEOUT_MS',
  'OPENCODE_AGENT_IDLE_TIMEOUT_MS',
  'OPENCODE_AGENT_KILL_GRACE_MS',
  'OPENCODE_AGENT_KILL_TREE',
  'OPENCODE_AGENT_MAX_OUTPUT_CHARS',
  'OPENCODE_AGENT_REQUIRE_CONFIRMATION',
  'OPENCODE_AGENT_USE_FOR_SELF_HEALING',
  'OPENCODE_AGENT_USE_FOR_SELF_UPGRADE',
  'OPENCODE_AGENT_ARGS_TEMPLATE',
  'OPENCODE_AUTH_BOOTSTRAP',
  'OPENCODE_AUTH_PROVIDER',
  'OPENCODE_AUTH_FILE',
  'OPENCODE_AUTH_OVERWRITE',
  'OPENCODE_ZEN_API_KEY',
  'OPENCODE_DOCTOR_SMOKE_TEST',
  'OPENCODE_AUTO_INSTALL',
  'OPENCODE_INSTALL_STRATEGY',
  'OPENCODE_INSTALL_COMMAND',
  'OPENCODE_INSTALL_TIMEOUT_MS',
  'OPENCODE_INSTALL_REQUIRE_APPROVAL',
  'OPENCODE_INSTALL_RETRY_AFTER_INSTALL',
  'OPENCODE_INSTALL_LOG_OUTPUT',
  'OPENCODE_INSTALL_USE_SUDO',
  'SYSTEM_EXECUTE_ENABLED',
  'SYSTEM_EXECUTE_ALLOW_ARBITRARY',
  'SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE',
  'SYSTEM_EXECUTE_DEFAULT_CWD',
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.OPENCODE_AUTH_BOOTSTRAP = 'false';
}

function enableMockOpenCode(argsTemplate) {
  process.env.OPENCODE_AGENT_ENABLED = 'true';
  process.env.OPENCODE_AGENT_COMMAND = process.execPath;
  process.env.OPENCODE_AGENT_CWD = '.';
  process.env.OPENCODE_AGENT_ARGS_TEMPLATE = argsTemplate;
  process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
  process.env.OPENCODE_AUTO_INSTALL = 'false';
  process.env.OPENCODE_AUTH_BOOTSTRAP = 'false';
}

function tmpRoot(name) {
  return path.join(process.cwd(), 'tmp', `opencode-agent-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function fakeSpawn(handler) {
  const calls = [];
  const spawnFn = (command, args = [], options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    const result = handler(call, calls.length);
    child.pid = result.pid ?? (4100 + calls.length);
    child.kill = () => {
      child.killed = true;
      return true;
    };
    process.nextTick(() => {
      if (result.error) {
        child.emit('error', new Error(result.error));
        return;
      }
      if (Array.isArray(result.outputEvents)) {
        for (const event of result.outputEvents) {
          setTimeout(() => {
            const stream = event.stream === 'stderr' ? child.stderr : child.stdout;
            stream.emit('data', event.data);
          }, event.delayMs ?? 0);
        }
      } else {
        if (result.stdout) child.stdout.emit('data', result.stdout);
        if (result.stderr) child.stderr.emit('data', result.stderr);
      }
      if (result.neverClose) return;
      child.emit('close', result.exitCode ?? 0);
    });
    return child;
  };
  return { spawnFn, calls };
}

async function createProjectFixture(name, options = {}) {
  const root = tmpRoot(name);
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: options.name || 'native-openclaw',
    scripts: { build: 'tsc' },
  }));
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{}');
  return root;
}

(async () => {
  try {
    {
      restoreEnv();
      assert.deepEqual(getOpenCodeInstallCommand('npm-global'), {
        command: 'npm',
        args: ['install', '-g', 'opencode-ai'],
      });
      assert.deepEqual(getOpenCodeInstallCommand('npm-local'), {
        command: 'npm',
        args: ['install', 'opencode-ai', '--save-dev'],
      });
      assert.deepEqual(getOpenCodeInstallCommand('brew'), {
        command: 'brew',
        args: ['install', 'anomalyco/tap/opencode'],
      });
      assert.deepEqual(getOpenCodeInstallCommand('bun-global'), {
        command: 'bun',
        args: ['add', '-g', 'opencode-ai'],
      });
      const official = getOpenCodeInstallCommand('official-script');
      assert.equal(official.command, 'sh');
      assert.match(official.args.join(' '), /curl -fsSL https:\/\/opencode\.ai\/install \| bash/);
      process.env.OPENCODE_INSTALL_COMMAND = 'node -e "console.log(1)"';
      const custom = getOpenCodeInstallCommand('custom');
      assert.equal(custom.command, 'node');
      assert.deepEqual(custom.args, ['-e', 'console.log(1)']);
    }

    {
      restoreEnv();
      process.env.OPENCODE_INSTALL_USE_SUDO = 'true';
      const result = await installOpenCode({
        strategy: 'npm-global',
        requireApproval: true,
        deps: { platform: 'win32' },
      });
      assert.equal(result.approvalRequired, true);
      assert.doesNotMatch(result.command, /^sudo\b/);
      assert.match(result.command, /^npm install -g opencode-ai$/);
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError(
        '',
        'Error: Model not found: opencode-zen/deepseek-v4-flash-free'
      );
      assert.equal(diagnostic.type, 'invalid-provider-prefix');
      assert.match(diagnostic.suggestion, /opencode\/deepseek-v4-flash-free/);
      assert.match(diagnostic.suggestion, /opencode-zen/);
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError('', 'Unexpected server error');
      assert.equal(diagnostic.type, 'server-error');
      assert.match(diagnostic.suggestion, /opencode run \/connect/);
      assert.match(diagnostic.suggestion, /OPENCODE_AUTH_BOOTSTRAP=true/);
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError('', 'Error: Unknown argument: prompt');
      assert.equal(diagnostic.type, 'invalid-cli-template');
      assert.match(diagnostic.suggestion, /run "\{\{task\}\}"/);
      assert.match(diagnostic.suggestion, /--dangerously-skip-permissions/);
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError('', 'Permission rejected for .env');
      assert.equal(diagnostic.type, 'permission-rejected');
      assert.match(diagnostic.suggestion, /dangerously-skip-permissions/);
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError({
        taskPrompt: 'Do not read .env. If permission is denied, skip it.',
        stdout: '',
        stderr: '',
      });
      assert.notEqual(diagnostic.type, 'permission-rejected');
    }

    {
      restoreEnv();
      const diagnostic = classifyOpenCodeError({
        stderr: 'The user rejected permission to use this specific tool call.',
      });
      assert.equal(diagnostic.type, 'permission-rejected');
    }

    {
      restoreEnv();
      const validation = validateOpenCodeArgsTemplate('run --prompt "{{task}}"');
      assert.equal(validation.valid, false);
      assert.match(validation.error, /does not support --prompt/);
    }

    {
      restoreEnv();
      const validation = validateOpenCodeArgsTemplate('run --dangerously-skip-permissions "{{task}}"');
      assert.equal(validation.valid, true);
      assert.equal(validation.dangerousSkipPermissions, true);
      assert.equal(validation.promptMode, 'positional');
      assert.match(validation.warnings.join('\n'), /trusted dev\/isolated/);
    }

    {
      restoreEnv();
      const validation = validateOpenCodeArgsTemplate('run --format json "{{task}}"');
      assert.equal(validation.valid, true);
      assert.equal(validation.dangerousSkipPermissions, false);
      assert.equal(validation.promptMode, 'positional');
    }

    {
      restoreEnv();
      const preview = buildOpenCodeArgsPreview('run --dangerously-skip-permissions "{{task}}"', 'x'.repeat(50));
      assert.deepEqual(preview, ['run', '--dangerously-skip-permissions', '[task:50 chars]']);
      const wrappedPreview = buildOpenCodeArgsPreview('run --dangerously-skip-permissions "{{task}}"', 'x'.repeat(50), 'analyze', {
        directMode: false,
        injectSafetyPreamble: true,
      });
      assert.deepEqual(wrappedPreview.slice(0, 2), ['run', '--dangerously-skip-permissions']);
      assert.match(wrappedPreview[2], /^\[task:\d+ chars\]$/);
      assert.deepEqual(previewOpenCodeArgs(['run', 'hello secret'], 'hello secret'), ['run', '[task:12 chars]']);
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-disabled');
      process.env.OPENCODE_AUTH_FILE = path.join(root, 'auth.json');
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'false';
      process.env.OPENCODE_ZEN_API_KEY = 'secret-disabled';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.match(result.reason, /not true/);
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-empty-key');
      process.env.OPENCODE_AUTH_FILE = path.join(root, 'auth.json');
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_ZEN_API_KEY = '';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.match(result.reason, /OPENCODE_ZEN_API_KEY is empty/);
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-create');
      const authFile = path.join(root, 'auth.json');
      process.env.OPENCODE_AUTH_FILE = authFile;
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_AUTH_PROVIDER = 'opencode';
      process.env.OPENCODE_ZEN_API_KEY = 'secret-create-key';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.created, true);
      assert.equal(result.updated, false);
      assert.equal(result.skipped, false);
      assert(!JSON.stringify(result).includes('secret-create-key'));
      const parsed = JSON.parse(await fs.readFile(authFile, 'utf-8'));
      assert.equal(parsed.opencode.key, 'secret-create-key');
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-wrong-provider');
      process.env.OPENCODE_AUTH_FILE = path.join(root, 'auth.json');
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_AUTH_PROVIDER = 'opencode-zen';
      process.env.OPENCODE_ZEN_API_KEY = 'secret-wrong-provider';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      assert.match(result.warning, /should be 'opencode'/);
      await assert.rejects(() => fs.access(process.env.OPENCODE_AUTH_FILE));
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-no-overwrite');
      const authFile = path.join(root, 'auth.json');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(authFile, JSON.stringify({ opencode: { type: 'api', key: 'old-key' } }, null, 2));
      process.env.OPENCODE_AUTH_FILE = authFile;
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_AUTH_PROVIDER = 'opencode';
      process.env.OPENCODE_AUTH_OVERWRITE = 'false';
      process.env.OPENCODE_ZEN_API_KEY = 'new-key';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.skipped, true);
      const parsed = JSON.parse(await fs.readFile(authFile, 'utf-8'));
      assert.equal(parsed.opencode.key, 'old-key');
    }

    {
      restoreEnv();
      const root = tmpRoot('auth-overwrite');
      const authFile = path.join(root, 'auth.json');
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(authFile, JSON.stringify({ opencode: { type: 'api', key: 'old-key' } }, null, 2));
      process.env.OPENCODE_AUTH_FILE = authFile;
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_AUTH_PROVIDER = 'opencode';
      process.env.OPENCODE_AUTH_OVERWRITE = 'true';
      process.env.OPENCODE_ZEN_API_KEY = 'new-key';
      const result = await bootstrapOpenCodeAuthFromEnv();
      assert.equal(result.ok, true);
      assert.equal(result.updated, true);
      const parsed = JSON.parse(await fs.readFile(authFile, 'utf-8'));
      assert.equal(parsed.opencode.key, 'new-key');
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      delete process.env.OPENCODE_AGENT_ARGS_TEMPLATE;
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AUTO_INSTALL = 'false';

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        assert.equal(call.args[0], 'run');
        assert.equal(call.args[1], '--dangerously-skip-permissions');
        assert.equal(call.args.includes('--prompt'), false);
        assert.match(call.args[2], /default args template/);
        assert.doesNotMatch(call.args[2], /Mode: analyze/);
        assert.doesNotMatch(call.args[2], /Do not read \.env/);
        return { stdout: 'default template ok\n' };
      });

      const result = await runOpenCodeAgent({
        task: 'default args template',
        mode: 'analyze',
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /default template ok/);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AUTO_INSTALL = 'false';

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        assert.deepEqual(call.args.slice(0, 2), ['run', '--dangerously-skip-permissions']);
        assert.match(call.args[2], /preserve exact env template/);
        assert.doesNotMatch(call.args[2], /Mode: review/);
        assert.doesNotMatch(call.args[2], /Do not read \.env/);
        return { stdout: 'env template preserved\n' };
      });

      const result = await runOpenCodeAgent({
        task: 'preserve exact env template',
        mode: 'review',
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /env template preserved/);
    }

    {
      restoreEnv();
      const root = await createProjectFixture('direct-mode-raw-task');
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_DIRECT_MODE = 'true';
      process.env.OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE = 'false';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';

      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13\n' };
        assert.deepEqual(call.args.slice(0, 2), ['run', '--dangerously-skip-permissions']);
        assert.match(call.args[2], /fix the direct mode bug/);
        assert(call.args[2].includes(root));
        assert.doesNotMatch(call.args[2], /Mode: patch/);
        assert.doesNotMatch(call.args[2], /Context:/);
        assert.doesNotMatch(call.args[2], /Do not read \.env/);
        return { stdout: 'direct raw task ok\n' };
      });

      const result = await runOpenCodeAgent({
        task: 'fix the direct mode bug',
        mode: 'patch',
        cwd: root,
        context: 'large internal context that must not be injected',
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /direct raw task ok/);
    }

    {
      restoreEnv();
      const root = await createProjectFixture('doctor-direct-mode');
      delete process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS;
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_DIRECT_MODE = 'true';
      process.env.OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE = 'false';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      process.env.OPENCODE_AGENT_TIMEOUT_MS = '900000';

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        if (call.args?.[0] === 'run' && call.args?.[1] === '--help') return { stdout: 'Usage: opencode run [message]\n' };
        return { stdout: '' };
      });

      const result = await runOpenCodeDoctor({
        cwd: root,
        includeUserConfig: false,
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });

      assert.equal(result.directMode, true);
      assert.equal(result.injectSafetyPreamble, false);
      assert.equal(result.idleTimeoutMs, 0);
      assert.equal(result.hardTimeoutMs, 900000);
      assert.equal(result.dangerousSkipPermissions, true);
      assert.deepEqual(result.argsPreview.slice(0, 2), ['run', '--dangerously-skip-permissions']);
      assert.match(result.suggestions.join('\n'), /OPENCODE_AGENT_IDLE_TIMEOUT_MS=0/);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_DIRECT_MODE = 'true';
      process.env.OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE = 'false';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      delete process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS;
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      let killedPid = null;
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5701 };
        return { neverClose: true, pid: 5702 };
      });
      const result = await runOpenCodeAgent({
        task: 'hard timeout still kills in direct mode',
        mode: 'test',
        timeoutMs: 20,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async (pid) => {
            killedPid = pid;
            return {
              pid,
              platform: 'win32',
              method: 'taskkill',
              ok: true,
              stdout: 'SUCCESS',
              stderr: '',
            };
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorType, 'timeout');
      assert.equal(result.killed, true);
      assert.equal(killedPid, 5702);
      assert.equal(result.killedBy, 'timeout');
    }

    {
      restoreEnv();
      const root = await createProjectFixture('doctor-invalid-prefix');
      await fs.writeFile(path.join(root, 'opencode.jsonc'), [
        '{',
        '  "$schema": "https://opencode.ai",',
        '  "model": "opencode-zen/deepseek-v4-flash-free",',
        '  "small_model": "opencode-zen/mimo-v2.5-free"',
        '}',
      ].join('\n'));

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        if (call.args?.[0] === 'run' && call.args?.[1] === '--help') return { stdout: 'Usage: opencode run [message]\n' };
        return { stdout: '' };
      });

      const result = await runOpenCodeDoctor({
        cwd: root,
        includeUserConfig: false,
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });

      assert.equal(result.installed, true);
      assert.equal(result.runHelpOk, true);
      assert.equal(result.configFiles.some((config) => config.invalidProviderPrefix), true);
      assert.match(result.warnings.join('\n'), /Invalid OpenCode provider prefix detected: opencode-zen\//);
      assert.match(result.suggestions.join('\n'), /opencode\/deepseek-v4-flash-free/);
    }

    {
      restoreEnv();
      const root = await createProjectFixture('doctor-valid-prefix');
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      await fs.writeFile(path.join(root, 'opencode.jsonc'), [
        '{',
        '  "$schema": "https://opencode.ai",',
        '  "model": "opencode/deepseek-v4-flash-free",',
        '  "small_model": "opencode/mimo-v2.5-free"',
        '}',
      ].join('\n'));

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        if (call.args?.[0] === 'run' && call.args?.[1] === '--help') return { stdout: 'Usage: opencode run [message]\n' };
        return { stdout: '' };
      });

      const result = await runOpenCodeDoctor({
        cwd: root,
        includeUserConfig: false,
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.configFiles.some((config) => config.invalidProviderPrefix), false);
      assert.doesNotMatch(result.warnings.join('\n'), /Invalid OpenCode provider prefix/);
      assert.equal(result.dangerousSkipPermissions, true);
      assert.equal(result.promptMode, 'positional');
      assert.deepEqual(result.argsPreview.slice(0, 2), ['run', '--dangerously-skip-permissions']);
      assert.match(result.argsPreview[2], /^\[task:\d+ chars\]$/);
      assert.match(result.templateWarnings.join('\n'), /trusted dev\/isolated/);
    }

    {
      restoreEnv();
      const root = await createProjectFixture('doctor-secret-redaction');
      const authFile = path.join(root, 'auth.json');
      process.env.OPENCODE_AUTH_FILE = authFile;
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'true';
      process.env.OPENCODE_AUTH_PROVIDER = 'opencode';
      process.env.OPENCODE_ZEN_API_KEY = 'super-secret-opencode-key';
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(authFile, JSON.stringify({ opencode: { type: 'api', key: 'super-secret-opencode-key' } }, null, 2));

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version') return { stdout: '1.15.13\n' };
        if (call.args?.[0] === 'run' && call.args?.[1] === '--help') return { stdout: 'Usage: opencode run [message]\n' };
        return { stdout: '' };
      });

      const result = await runOpenCodeDoctor({
        cwd: root,
        includeUserConfig: false,
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });

      assert.equal(result.zenApiKeyPresent, true);
      assert.equal(result.authProviderExists, true);
      assert(!JSON.stringify(result).includes('super-secret-opencode-key'));
    }

    {
      restoreEnv();
      const fake = fakeSpawn((call) => {
        if (call.command === 'opencode.cmd') return { stdout: '1.15.13\n' };
        return { error: `spawn ${call.command} ENOENT` };
      });
      const detection = await detectOpenCode('opencode', {
        spawnFn: fake.spawnFn,
        platform: 'win32',
      });
      assert.equal(detection.installed, true);
      assert.equal(detection.executionStrategy, 'resolved-cmd');
      assert.equal(detection.resolvedCommand, 'opencode.cmd');
      assert.equal(detection.shell, false);
      assert.equal(fake.calls[0].command, 'opencode');
      assert.equal(fake.calls[0].options.shell ?? false, false);
      assert.equal(fake.calls[1].command, 'opencode.cmd');
      assert.equal(fake.calls[1].options.shell ?? false, false);
    }

    {
      restoreEnv();
      const fake = fakeSpawn((call) => {
        if (call.options.shell === true) return { stdout: '1.15.13\n' };
        return { error: `spawn ${call.command} ENOENT` };
      });
      const detection = await detectOpenCode('opencode', {
        spawnFn: fake.spawnFn,
        platform: 'win32',
      });
      assert.equal(detection.installed, true);
      assert.equal(detection.executionStrategy, 'windows-shell');
      assert.equal(detection.resolvedCommand, 'opencode');
      assert.equal(detection.shell, true);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';

      const fake = fakeSpawn((call) => {
        if (call.args?.[0] === '--version' && call.options.shell !== true) {
          return { error: `spawn ${call.command} ENOENT` };
        }
        if (call.args?.[0] === '--version' && call.options.shell === true) {
          return { stdout: '1.15.13\n' };
        }
        assert.equal(call.options.shell, true);

        const effectiveCommand = [call.command, ...(call.args || [])].join(' ');

        assert.match(effectiveCommand, /\brun\b/);
        assert.match(effectiveCommand, /--dangerously-skip-permissions/);
        assert.match(effectiveCommand, /windows shell fallback task/);

        return { stdout: 'shell execution ok\n' };
      });

      const result = await runOpenCodeAgent({
        task: 'windows shell fallback task',
        mode: 'patch',
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
        },
      });

      assert.equal(result.ok, true);
      assert.match(result.stdout, /shell execution ok/);
      assert.equal(fake.calls.some((call) => {
      if (call.options.shell !== true) return false;

      const effectiveCommand = [call.command, ...(call.args || [])].join(' ');

        return (
          /\brun\b/.test(effectiveCommand) &&
          /--dangerously-skip-permissions/.test(effectiveCommand) &&
          /windows shell fallback task/.test(effectiveCommand)
        );
      }), true);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run --prompt "{{task}}"';
      let spawnCalls = 0;
      const fake = fakeSpawn(() => {
        spawnCalls += 1;
        return { stdout: 'should not execute\n' };
      });
      const result = await runOpenCodeAgent({
        task: 'invalid prompt template',
        mode: 'patch',
        deps: {
          spawnFn: fake.spawnFn,
          platform: process.platform,
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.errorType, 'invalid-cli-template');
      assert.match(result.error, /does not support --prompt/);
      assert.equal(spawnCalls, 0);
    }

    {
      restoreEnv();
      const explicit = await createProjectFixture('cwd-explicit');
      const envRoot = await createProjectFixture('cwd-env-unused');
      const result = resolveOpenCodeCwd({
        explicitCwd: explicit,
        envCwd: envRoot,
        startDir: envRoot,
      });
      assert.equal(result.source, 'input');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(explicit));
    }

    {
      restoreEnv();
      const envRoot = await createProjectFixture('cwd-env');
      const result = resolveOpenCodeCwd({
        envCwd: envRoot,
        startDir: process.cwd(),
      });
      assert.equal(result.source, 'env');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(envRoot));
    }

    {
      restoreEnv();
      const root = await createProjectFixture('cwd-auto-root');
      const nested = path.join(root, 'src', 'nested');
      await fs.mkdir(nested, { recursive: true });
      const result = resolveOpenCodeCwd({ startDir: nested });
      assert.equal(result.source, 'auto-detected');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(root));
      assert.equal(findProjectRoot(nested), path.resolve(root));
    }

    {
      restoreEnv();
      const root = await createProjectFixture('cwd-dist-parent');
      const dist = path.join(root, 'dist');
      await fs.mkdir(dist, { recursive: true });
      const result = resolveOpenCodeCwd({ startDir: dist });
      assert.equal(result.source, 'auto-detected');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(root));
    }

    {
      restoreEnv();
      const root = await createProjectFixture('cwd-invalid-env');
      const nested = path.join(root, 'src', 'nested');
      await fs.mkdir(nested, { recursive: true });
      const result = resolveOpenCodeCwd({
        envCwd: path.join(root, 'missing'),
        startDir: nested,
      });
      assert.equal(result.source, 'auto-detected');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(root));
    }

    {
      restoreEnv();
      const dockerLikeRoot = path.join(tmpRoot('cwd-docker-like'), 'app');
      await fs.mkdir(path.join(dockerLikeRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(dockerLikeRoot, 'package.json'), JSON.stringify({
        name: 'native-openclaw',
        scripts: { build: 'tsc' },
      }));
      const result = resolveOpenCodeCwd({ startDir: dockerLikeRoot });
      assert.equal(result.source, 'auto-detected');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(dockerLikeRoot));
    }

    {
      restoreEnv();
      const rootPath = path.parse(process.cwd()).root;
      const result = resolveOpenCodeCwd({
        explicitCwd: rootPath,
        startDir: process.cwd(),
      });
      assert.notEqual(result.source, 'input');
      assert.notEqual(path.resolve(result.cwd), path.resolve(rootPath));
      assert.equal(result.valid, true);
    }

    if (process.platform === 'win32') {
      restoreEnv();
      const root = await createProjectFixture('cwd-windows-forward-slash');
      const result = resolveOpenCodeCwd({
        explicitCwd: root.replace(/\\/g, '/'),
        startDir: process.cwd(),
      });
      assert.equal(result.source, 'input');
      assert.equal(result.valid, true);
      assert.equal(result.cwd, path.resolve(root));
    }

    {
      restoreEnv();
      const fake = fakeSpawn(() => ({ stdout: 'v22.0.0\n' }));
      const detection = await detectOpenCode('node', {
        spawnFn: fake.spawnFn,
        platform: process.platform,
      });
      assert.equal(detection.installed, true);
      assert.match(detection.version || '', /^v?\d+\./);
    }

    {
      restoreEnv();
      const fake = fakeSpawn(() => ({ error: 'spawn missing-opencode ENOENT' }));
      const detection = await detectOpenCode(`missing-opencode-${Date.now()}`, {
        spawnFn: fake.spawnFn,
        platform: process.platform,
      });
      assert.equal(detection.installed, false);
      assert.match(detection.error || '', /missing-opencode|ENOENT|not recognized|not found/i);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = `missing-opencode-${Date.now()}`;
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      const result = await runOpenCodeAgent({ task: 'review src/index.ts', mode: 'review' });
      assert.equal(result.ok, false);
      assert.match(result.error, /OpenCode CLI is not installed/i);
      assert.equal(result.detection.installed, false);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = `missing-opencode-${Date.now()}`;
      process.env.OPENCODE_AUTO_INSTALL = 'true';
      process.env.OPENCODE_INSTALL_REQUIRE_APPROVAL = 'true';
      process.env.OPENCODE_INSTALL_STRATEGY = 'npm-global';
      const result = await runOpenCodeAgent({ task: 'review src/index.ts', mode: 'review' });
      assert.equal(result.ok, false);
      assert.match(result.error, /Install now/i);
      assert.match(result.error, /approve opencode install/);
      assert(result.installApprovalId);
      assert.equal(result.install.approvalRequired, true);
    }

    {
      restoreEnv();
      process.env.OPENCODE_INSTALL_STRATEGY = 'custom';
      process.env.OPENCODE_INSTALL_COMMAND = 'node -e "process.exit(2)"';
      process.env.OPENCODE_INSTALL_REQUIRE_APPROVAL = 'false';
      process.env.SYSTEM_EXECUTE_ENABLED = 'true';
      process.env.SYSTEM_EXECUTE_ALLOW_ARBITRARY = 'true';
      process.env.SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE = 'true';
      const result = await installOpenCode();
      assert.equal(result.ok, false);
      assert.match(result.error || '', /failed|verified/i);
      assert.equal(result.strategy, 'custom');
    }

    {
      restoreEnv();
      const root = tmpRoot('auto-install');
      await fs.mkdir(root, { recursive: true });
      const commandPath = path.join(root, 'opencode-mock');
      const fake = fakeSpawn((call, index) => {
        if (call.args?.[0] === '--version') {
          return index < 3
            ? { error: 'spawn opencode-mock ENOENT' }
            : { stdout: '1.15.13\n', exitCode: 0 };
        }
        return { stdout: call.args.join(' '), exitCode: 0 };
      });

      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = commandPath;
      process.env.OPENCODE_AGENT_CWD = '.';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = '-e "console.log(process.argv[1])" "{{task}}"';
      process.env.OPENCODE_AUTO_INSTALL = 'true';
      process.env.OPENCODE_INSTALL_STRATEGY = 'custom';
      process.env.OPENCODE_INSTALL_COMMAND = 'echo installed';
      process.env.OPENCODE_INSTALL_REQUIRE_APPROVAL = 'false';
      process.env.OPENCODE_INSTALL_RETRY_AFTER_INSTALL = 'true';
      process.env.SYSTEM_EXECUTE_ENABLED = 'true';
      process.env.SYSTEM_EXECUTE_ALLOW_ARBITRARY = 'true';
      process.env.SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE = 'true';

      const result = await runOpenCodeAgent({
        task: 'retry after install',
        mode: 'analyze',
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          runSystemExecuteFn: async () => ({
            ok: true,
            content: 'installed',
            stdout: 'installed',
            stderr: '',
            exitCode: 0,
          }),
        },
      });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /retry after install/);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'false';
      const result = await runOpenCodeAgent({ task: 'review src/index.ts', mode: 'review' });
      assert.equal(result.ok, false);
      assert.match(result.error, /disabled/i);
      assert.equal(result.mode, 'review');
    }

    {
      restoreEnv();
      enableMockOpenCode('-e "console.log(process.argv[1])" "{{task}}"');
      const result = await runOpenCodeAgent({ task: 'mock coding task', mode: 'analyze' });
      assert.equal(result.ok, true);
      assert.match(result.stdout, /mock coding task/);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = process.execPath;
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = '-e "console.log(process.cwd())" "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      const result = await runOpenCodeAgent({ task: 'print cwd', mode: 'review' });
      assert.equal(result.ok, true);
      assert.equal(path.resolve(result.stdout.trim()), path.resolve(process.cwd()));
    }

    {
      restoreEnv();
      enableMockOpenCode('-e "setTimeout(() => console.log(\'late\'), 250)" "{{task}}"');
      const result = await runOpenCodeAgent({ task: 'timeout task', mode: 'test', timeoutMs: 25 });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.match(result.summary, /timeout|timed out/i);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '0';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      let killedPid = null;
      const fake = fakeSpawn((callNoArg, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5101 };
        return { neverClose: true, pid: 5102 };
      });
      const result = await runOpenCodeAgent({
        task: 'hard timeout never closes',
        mode: 'test',
        timeoutMs: 20,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async (pid) => {
            killedPid = pid;
            return { pid, platform: 'win32', method: 'taskkill', ok: true };
          },
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.errorType, 'timeout');
      assert.equal(result.killed, true);
      assert.equal(result.killedBy, 'timeout');
      assert.equal(killedPid, 5102);
      assert.match(result.error, /exceeded timeout/i);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '0';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      let killedPid = null;
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { error: 'spawn opencode EPERM', pid: 5201 };
        if (index === 2) return { error: 'spawn opencode.cmd ENOENT', pid: 5202 };
        if (index === 3) return { stdout: '1.15.13', exitCode: 0, pid: 5203 };
        return { neverClose: true, pid: 5204 };
      });
      const result = await runOpenCodeAgent({
        task: 'windows shell timeout',
        mode: 'test',
        timeoutMs: 20,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async (pid) => {
            killedPid = pid;
            return { pid, platform: 'win32', method: 'taskkill', ok: true };
          },
        },
      });
      assert.equal(result.errorType, 'timeout');
      assert.equal(killedPid, 5204);
      assert.equal(fake.calls[3].options.shell, true);

      const effectiveCommand = [
      fake.calls[3].command,
      ...(fake.calls[3].args || []),
      ].join(' ');

      assert.match(effectiveCommand, /\brun\b/);
      assert.match(effectiveCommand, /windows shell timeout/);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '0';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      let killPlatform = null;
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5301 };
        return { neverClose: true, pid: 5302 };
      });
      const result = await runOpenCodeAgent({
        task: 'unix group timeout',
        mode: 'test',
        timeoutMs: 20,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'linux',
          killProcessTreeFn: async (pid, options) => {
            killPlatform = options.platform;
            return { pid, platform: 'linux', method: 'process-group', ok: true };
          },
        },
      });
      assert.equal(result.errorType, 'timeout');
      assert.equal(killPlatform, 'linux');
      assert.equal(fake.calls[1].options.detached, true);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '20';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5401 };
        return { neverClose: true, pid: 5402 };
      });
      const result = await runOpenCodeAgent({
        task: 'idle timeout task',
        mode: 'test',
        timeoutMs: 200,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async (pid) => ({ pid, platform: 'win32', method: 'taskkill', ok: true }),
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.errorType, 'idle-timeout');
      assert.match(result.error, /produced no output/i);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '25';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5501 };
        return {
          neverClose: true,
          pid: 5502,
          outputEvents: [
            { delayMs: 5, data: 'tick1\n' },
            { delayMs: 15, data: 'tick2\n' },
            { delayMs: 30, data: 'tick3\n' },
            { delayMs: 45, data: 'tick4\n' },
          ],
        };
      });
      const result = await runOpenCodeAgent({
        task: 'idle reset task',
        mode: 'test',
        timeoutMs: 60,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async (pid) => ({ pid, platform: 'win32', method: 'taskkill', ok: true }),
        },
      });
      assert.equal(result.errorType, 'timeout');
      assert.match(result.stdout, /tick4/);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = 'opencode';
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AGENT_ARGS_TEMPLATE = 'run "{{task}}"';
      process.env.OPENCODE_AGENT_REQUIRE_CONFIRMATION = 'false';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '0';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '10';
      const fake = fakeSpawn((call, index) => {
        if (index === 1) return { stdout: '1.15.13', exitCode: 0, pid: 5601 };
        return { neverClose: true, pid: 5602 };
      });
      const started = Date.now();
      const result = await runOpenCodeAgent({
        task: 'kill never resolves task',
        mode: 'test',
        timeoutMs: 20,
        deps: {
          spawnFn: fake.spawnFn,
          platform: 'win32',
          killProcessTreeFn: async () => new Promise(() => {}),
        },
      });
      assert.equal(result.errorType, 'timeout');
      assert(Date.now() - started < 500);
    }

    {
      restoreEnv();
      enableMockOpenCode('-e "console.log(\'x\'.repeat(200))" "{{task}}"');
      process.env.OPENCODE_AGENT_MAX_OUTPUT_CHARS = '40';
      const result = await runOpenCodeAgent({ task: 'large output', mode: 'review' });
      assert.equal(result.ok, true);
      assert.equal(result.truncated, true);
      assert(result.stdout.length < 100);
      assert.match(result.stdout, /truncated/i);
    }

    {
      restoreEnv();
      enableMockOpenCode('-e "console.log(\'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\')" "{{task}}"');
      const result = await runOpenCodeAgent({ task: 'secret output', mode: 'review' });
      assert.equal(result.ok, true);
      assert(!result.stdout.includes('abcdefghijklmnopqrstuvwxyz'));
      assert.match(result.stdout, /\[REDACTED\]/);
    }

    {
      restoreEnv();
      const root = tmpRoot('self-healing-direct-edit');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const script = "const fs=require('fs'),path=require('path');fs.mkdirSync('src',{recursive:true});fs.writeFileSync(path.join('src','direct-heal.ts'),'export const directHeal = true;\\n');";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_CWD = path.relative(process.cwd(), root);
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      const agent = new CodingAgent();
      const changed = await agent.applyBugFix({
        userInput: 'fix via opencode direct edit',
        analysis: {
          summary: 'direct edit',
          likelyCause: 'fixture needs a file',
          affectedFiles: ['src/direct-heal.ts'],
          fixStrategy: 'let opencode edit the repository',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/direct-heal.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        runId: 'heal-test',
        loop: 1,
      });

      assert.deepEqual(changed, ['src/direct-heal.ts']);
      assert.match(await fs.readFile(path.join(root, 'src', 'direct-heal.ts'), 'utf-8'), /directHeal = true/);
      assert.deepEqual(patchApplier.getChangedFiles(), ['src/direct-heal.ts']);
      await snapshot.rollback();
      await assert.rejects(() => fs.access(path.join(root, 'src', 'direct-heal.ts')));
    }

    {
      restoreEnv();
      const root = tmpRoot('self-upgrade-direct-edit');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const script = "const fs=require('fs'),path=require('path');fs.mkdirSync('src',{recursive:true});fs.writeFileSync(path.join('src','direct-upgrade.ts'),'export const directUpgrade = true;\\n');";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_CWD = path.relative(process.cwd(), root);
      process.env.OPENCODE_AGENT_USE_FOR_SELF_UPGRADE = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      const agent = new CodingAgent();
      const changed = await agent.applyUpgrade({
        userInput: 'upgrade via opencode direct edit',
        analysis: {
          summary: 'direct upgrade',
          missingCapability: 'fixture file',
          feasible: true,
          targetFiles: ['src/direct-upgrade.ts'],
          implementationStrategy: 'let opencode edit the repository',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/direct-upgrade.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        runId: 'upgrade-test',
        loop: 1,
      });

      assert.deepEqual(changed, ['src/direct-upgrade.ts']);
      assert.match(await fs.readFile(path.join(root, 'src', 'direct-upgrade.ts'), 'utf-8'), /directUpgrade = true/);
      assert.deepEqual(patchApplier.getChangedFiles(), ['src/direct-upgrade.ts']);
    }

    {
      restoreEnv();
      const root = tmpRoot('timeout-with-changes');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const script = "const fs=require('fs'),path=require('path');fs.mkdirSync('src',{recursive:true});fs.writeFileSync(path.join('src','timeout-change.ts'),'export const timeoutChange = true;\\n');setTimeout(()=>{},2000);";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_CWD = root;
      process.env.OPENCODE_AGENT_TIMEOUT_MS = '250';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      const openCodeState = {};
      const agent = new CodingAgent();
      const changed = await agent.applyBugFix({
        userInput: 'fix via opencode timeout with changes',
        analysis: {
          summary: 'timeout with changes',
          likelyCause: 'external agent changed files before timing out',
          affectedFiles: ['src/timeout-change.ts'],
          fixStrategy: 'continue to QA with changed files',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/timeout-change.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.deepEqual(changed, ['src/timeout-change.ts']);
      assert.equal(openCodeState.lastErrorType, 'timed-out-with-changes');
      assert.match(openCodeState.lastSuggestion, /QA will validate/);
    }

    {
      restoreEnv();
      const root = tmpRoot('timeout-no-changes-fallback');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      enableMockOpenCode('-e "setTimeout(()=>{},2000)" "{{task}}"');
      process.env.OPENCODE_AGENT_CWD = root;
      process.env.OPENCODE_AGENT_TIMEOUT_MS = '25';
      process.env.OPENCODE_AGENT_IDLE_TIMEOUT_MS = '0';
      process.env.OPENCODE_AGENT_KILL_GRACE_MS = '5';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      let providerCalls = 0;
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async () => {
          providerCalls += 1;
          return {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    path: 'src/timeout-fallback.ts',
                    action: 'create',
                    content: 'export const timeoutFallback = true;\n',
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const openCodeState = {};
      const agent = new CodingAgent(provider);
      const changed = await agent.applyBugFix({
        userInput: 'fix via timeout fallback',
        analysis: {
          summary: 'timeout fallback',
          likelyCause: 'OpenCode hung before changes',
          affectedFiles: ['src/timeout-fallback.ts'],
          fixStrategy: 'use internal CodingAgent',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/timeout-fallback.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.equal(providerCalls, 1);
      assert.deepEqual(changed, ['src/timeout-fallback.ts']);
      assert.equal(openCodeState.fallbackUsed, true);
      assert.equal(openCodeState.unavailable, true);
      assert.equal(openCodeState.lastErrorType, 'timeout');
      assert.match(openCodeState.unavailableReason, /exceeded timeout/i);
    }

    {
      restoreEnv();
      const root = tmpRoot('success-no-changes-fallback-context');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      enableMockOpenCode('-e "console.log(\'OpenCode analysis: create fallback-context.ts\')" "{{task}}"');
      process.env.OPENCODE_AGENT_CWD = root;
      process.env.OPENCODE_AGENT_DIRECT_MODE = 'true';
      process.env.OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE = 'false';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      let providerPrompt = '';
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async (input) => {
          providerPrompt = input.messages[0].content;
          return {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    path: 'src/fallback-context.ts',
                    action: 'create',
                    content: 'export const fallbackContext = true;\n',
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const openCodeState = {};
      const agent = new CodingAgent(provider);
      const changed = await agent.applyBugFix({
        userInput: 'fix via opencode no-change analysis fallback',
        analysis: {
          summary: 'fallback context',
          likelyCause: 'opencode analyzed but did not edit',
          affectedFiles: ['src/fallback-context.ts'],
          fixStrategy: 'use OpenCode analysis as provider context',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/fallback-context.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.deepEqual(changed, ['src/fallback-context.ts']);
      assert.equal(openCodeState.fallbackUsed, true);
      assert.match(openCodeState.lastSuggestion, /without file changes/);
      assert.match(openCodeState.lastOutput, /OpenCode analysis/);
      assert.match(providerPrompt, /OpenCode output before fallback/);
      assert.match(providerPrompt, /OpenCode analysis: create fallback-context\.ts/);
    }

    {
      restoreEnv();
      const root = tmpRoot('permission-rejected-with-changes');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const script = "const fs=require('fs'),path=require('path');fs.mkdirSync('src',{recursive:true});fs.writeFileSync(path.join('src','permission-change.ts'),'export const permissionChange = true;\\n');process.stderr.write('The user rejected permission to use this specific tool call.\\n');process.exit(1);";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_CWD = root;
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      const openCodeState = {};
      const agent = new CodingAgent();
      const changed = await agent.applyBugFix({
        userInput: 'fix via opencode permission warning with changes',
        analysis: {
          summary: 'permission warning with changes',
          likelyCause: 'external agent touched protected file but also changed source',
          affectedFiles: ['src/permission-change.ts'],
          fixStrategy: 'continue to QA with changed files',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/permission-change.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.deepEqual(changed, ['src/permission-change.ts']);
      assert.equal(openCodeState.lastErrorType, 'permission-warning');
      assert.match(openCodeState.lastSuggestion, /permission rejection/);
    }

    {
      restoreEnv();
      const script = "process.stderr.write('The user rejected permission to use this specific tool call.\\n');process.exit(1);";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const root = tmpRoot('permission-rejected-no-changes');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      let providerCalls = 0;
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async () => {
          providerCalls += 1;
          return {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    path: 'src/permission-fallback.ts',
                    action: 'create',
                    content: 'export const permissionFallback = true;\\n',
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const openCodeState = {};
      const agent = new CodingAgent(provider);
      const changed = await agent.applyBugFix({
        userInput: 'fix via opencode permission fallback',
        analysis: {
          summary: 'permission fallback',
          likelyCause: 'opencode permission rejected',
          affectedFiles: ['src/permission-fallback.ts'],
          fixStrategy: 'use model coding agent',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/permission-fallback.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.equal(providerCalls, 1);
      assert.deepEqual(changed, ['src/permission-fallback.ts']);
      assert.equal(openCodeState.fallbackUsed, true);
      assert.equal(openCodeState.lastErrorType, 'permission-rejected');
      assert.equal(openCodeState.unavailable, true);
    }

    {
      restoreEnv();
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = `missing-opencode-${Date.now()}`;
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const root = tmpRoot('unavailable-state');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      let providerCalls = 0;
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async () => {
          providerCalls += 1;
          return {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    path: 'src/unavailable.ts',
                    action: 'create',
                    content: `export const providerCalls = ${providerCalls};\n`,
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const openCodeState = {};
      const agent = new CodingAgent(provider);
      const baseInput = {
        userInput: 'fix with unavailable opencode',
        analysis: {
          summary: 'fallback',
          likelyCause: 'opencode unavailable',
          affectedFiles: ['src/unavailable.ts'],
          fixStrategy: 'use model coding agent',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/unavailable.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        runId: 'heal-unavailable',
        openCodeState,
      };

      await agent.applyBugFix({ ...baseInput, loop: 1 });
      await agent.applyBugFix({ ...baseInput, loop: 2 });

      assert.equal(providerCalls, 2);
      assert.equal(openCodeState.attempted, true);
      assert.equal(openCodeState.attempts, 1);
      assert.equal(openCodeState.unavailable, true);
      assert.match(openCodeState.unavailableReason, /not installed|ENOENT|not found|not recognized/i);
    }

    {
      restoreEnv();
      enableMockOpenCode('-e "process.exit(1)" "{{task}}"');
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const root = tmpRoot('fallback');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      let providerCalls = 0;
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async () => {
          providerCalls += 1;
          return {
            message: {
              content: JSON.stringify({
                files: [
                  {
                    path: 'src/fallback.ts',
                    action: 'create',
                    content: 'export const fallback = true;\n',
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };

      const agent = new CodingAgent(provider);
      const changed = await agent.applyBugFix({
        userInput: 'fix via fallback',
        analysis: {
          summary: 'fallback',
          likelyCause: 'opencode failed',
          affectedFiles: ['src/fallback.ts'],
          fixStrategy: 'use model coding agent',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/fallback.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
      });

      assert.equal(providerCalls, 1);
      assert.deepEqual(changed, ['src/fallback.ts']);
      assert.match(await fs.readFile(path.join(root, 'src', 'fallback.ts'), 'utf-8'), /fallback = true/);
    }

    {
      restoreEnv();
      const script = "process.stderr.write('Error: Model not found: opencode-zen/deepseek-v4-flash-free\\n');process.exit(1)";
      enableMockOpenCode(`-e "${script}" "{{task}}"`);
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const root = tmpRoot('diagnostic-fallback');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      const snapshot = new SnapshotManager(root, path.join(root, 'snapshot'));
      const patchApplier = new PatchApplier(root, snapshot);
      const provider = {
        id: 'mock',
        displayName: 'Mock Provider',
        listModels: async () => [],
        chat: async () => ({
          message: {
            content: JSON.stringify({
              files: [
                {
                  path: 'src/diagnostic-fallback.ts',
                  action: 'create',
                  content: 'export const diagnosticFallback = true;\n',
                },
              ],
            }),
          },
          model: 'mock',
          latencyMs: 1,
        }),
      };
      const openCodeState = {};
      const agent = new CodingAgent(provider);
      const changed = await agent.applyBugFix({
        userInput: 'fix with diagnostic fallback',
        analysis: {
          summary: 'fallback',
          likelyCause: 'opencode model config',
          affectedFiles: ['src/diagnostic-fallback.ts'],
          fixStrategy: 'use model coding agent',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{ path: 'src/diagnostic-fallback.ts', action: 'create', reason: 'fixture' }],
          testStrategy: 'build',
          riskLevel: 'low',
        },
        patchApplier,
        openCodeState,
      });

      assert.deepEqual(changed, ['src/diagnostic-fallback.ts']);
      assert.equal(openCodeState.fallbackUsed, true);
      assert.equal(openCodeState.lastErrorType, 'invalid-provider-prefix');
      assert.match(openCodeState.lastSuggestion, /opencode\/deepseek-v4-flash-free/);
      assert.equal(openCodeState.unavailable, true);
      assert.match(openCodeState.unavailableReason, /provider prefix opencode-zen\/ is invalid/);
    }

    console.log('opencode-agent tests passed');
  } finally {
    restoreEnv();
  }
})().catch((err) => {
  restoreEnv();
  console.error(err);
  process.exit(1);
});
