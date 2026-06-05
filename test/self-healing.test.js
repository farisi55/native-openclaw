const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');

const {
  PatchApplier,
  DiffGenerator,
  QAAgent,
  SafetyPolicy,
  SelfHealingEngine,
  SelfUpgradeEngine,
  SnapshotManager,
  filterRestartRelevantChangedFiles,
  isRestartRequiredForChangedFiles,
  redactSecrets,
} = require('../dist/self-healing');
const { LifecycleManager } = require('../dist/runtime/lifecycle-manager');

function tmpRoot(name) {
  return path.join(process.cwd(), 'tmp', `self-healing-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function config(root, overrides = {}) {
  return {
    enabled: true,
    maxLoops: 3,
    autoApply: true,
    autoInstall: true,
    autoRollback: true,
    testCommands: ['npm run build'],
    timeoutMs: 30_000,
    workdir: root,
    runsDir: path.join(root, 'workspace', 'self-healing', 'runs'),
    dataDir: path.join(root, 'data'),
    redactSecrets: true,
    temperature: 0.1,
    autoRestart: false,
    ...overrides,
  };
}

function fakeLifecycle(options = {}) {
  const calls = { schedules: 0, exits: 0 };
  const manager = new LifecycleManager({
    isTestRuntime: false,
    delayMs: 1500,
    exitCode: 42,
    setTimeoutFn: () => {
      calls.schedules += 1;
      return 0;
    },
    exitFn: () => {
      calls.exits += 1;
    },
    ...options,
  });
  return { manager, calls };
}

function commandResult(command, exitCode, stdout = '', stderr = '') {
  return {
    command,
    exitCode,
    stdout,
    stderr,
    durationMs: 1,
    timedOut: false,
  };
}

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreSavedEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function prepareRoot(name) {
  const root = tmpRoot(name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"build":"echo ok"}}\n');
  return root;
}

(async () => {
  {
    const diff = new DiffGenerator({ maxDiffChars: 10_000 }).generateFileDiff({
      path: 'src/example.ts',
      beforeContent: 'export const x = 1;\n',
      afterContent: 'export const x = 2;\n',
    });
    assert.equal(diff.changeType, 'updated');
    assert(diff.additions >= 1);
    assert(diff.deletions >= 1);
    assert.match(diff.diffText, /-export const x = 1/);
    assert.match(diff.diffText, /\+export const x = 2/);
  }

  {
    const diff = new DiffGenerator().generateFileDiff({
      path: 'src/created.ts',
      beforeContent: null,
      afterContent: 'export const y = 1;\n',
    });
    assert.equal(diff.changeType, 'created');
    assert.equal(diff.additions, 1);
    assert.equal(diff.deletions, 0);
  }

  {
    const diff = new DiffGenerator().generateFileDiff({
      path: 'src/deleted.ts',
      beforeContent: 'old\n',
      afterContent: null,
    });
    assert.equal(diff.changeType, 'deleted');
    assert.equal(diff.additions, 0);
    assert.equal(diff.deletions, 1);
  }

  {
    const diff = new DiffGenerator().generateFileDiff({
      path: 'src/secret.ts',
      beforeContent: 'const token = "Bearer abc123";\n',
      afterContent: 'const token = "xkeysib-123456789012345";\n',
    });
    assert.match(diff.diffText, /\[REDACTED/);
    assert(!diff.diffText.includes('abc123'));
    assert(!diff.diffText.includes('xkeysib-123456789012345'));
  }

  {
    const diff = new DiffGenerator().generateFileDiff({
      path: '.env',
      beforeContent: 'SECRET=old\n',
      afterContent: 'SECRET=new\n',
    });
    assert.equal(diff.diffText, 'Diff omitted for protected file.');
  }

  {
    const root = await prepareRoot('loop-pass');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    let qaCalls = 0;
    const engine = new SelfHealingEngine(config(root), {
      analyzer: {
        analyze: async () => ({
          summary: 'bug',
          likelyCause: 'fixture fails',
          affectedFiles: ['src/bug.ts'],
          fixStrategy: 'rewrite fixture',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyBugFix: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/bug.ts', action: 'create', content: `export const fixed = ${qaCalls > 0 ? 'true' : 'false'};\n` },
        ]),
      },
      testRunner: {
        runAll: async () => {
          qaCalls += 1;
          return qaCalls === 1
            ? [commandResult('npm run build', 1, '', 'AssertionError: still failing')]
            : [commandResult('npm run build', 0, 'ok', '')];
        },
      },
    });

    const run = await engine.run({ userInput: 'fix fixture', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.equal(run.loops.length, 2);
    assert(run.fileDiffs?.some((diff) => diff.path === 'src/bug.ts'));
    const report = await engine.getReport(run.id);
    assert.match(report ?? '', /## File Changes Summary/);
    assert.match(report ?? '', /## Per-File Diff/);
    assert.match(report ?? '', /src\/bug\.ts/);
    const diffReport = await engine.getDiffReport(run.id);
    assert.match(diffReport ?? '', /src\/bug\.ts/);
  }

  {
    const root = await prepareRoot('missing-dep');
    const installed = [];
    let qaCalls = 0;
    const engine = new SelfHealingEngine(config(root), {
      analyzer: {
        analyze: async () => ({
          summary: 'missing dep',
          likelyCause: 'package missing',
          affectedFiles: [],
          fixStrategy: 'install package',
          confidence: 0.8,
        }),
      },
      codingAgent: { applyBugFix: async () => [] },
      dependencyResolver: {
        install: async (packages) => {
          installed.push(...packages);
          return [commandResult('npm install lodash-es --save-dev', 0, 'installed', '')];
        },
      },
      testRunner: {
        runAll: async () => {
          qaCalls += 1;
          return qaCalls === 1
            ? [commandResult('npm run build', 1, '', "Cannot find module 'lodash-es'")]
            : [commandResult('npm run build', 0, 'ok', '')];
        },
      },
    });

    const run = await engine.run({ userInput: 'fix missing dependency', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.deepEqual(installed, ['lodash-es']);
  }

  {
    const root = await prepareRoot('permission-warning-qa-pass');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const engine = new SelfHealingEngine(config(root, { maxLoops: 1 }), {
      analyzer: {
        analyze: async () => ({
          summary: 'permission warning',
          likelyCause: 'OpenCode touched source but reported permission rejection',
          affectedFiles: ['src/permission-warning.ts'],
          fixStrategy: 'accept only if QA passes',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyBugFix: async ({ patchApplier, openCodeState }) => {
          openCodeState.lastErrorType = 'permission-warning';
          openCodeState.lastError = 'OpenCode permission rejected after changing files';
          return patchApplier.applyAll([
            { path: 'src/permission-warning.ts', action: 'create', content: 'export const ok = true;\n' },
          ]);
        },
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 0, 'ok', '')],
      },
    });

    const run = await engine.run({ userInput: 'fix with permission warning', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.match(run.finalSummary, /permission-rejected but produced meaningful changes/);
    await fs.access(path.join(root, 'src', 'permission-warning.ts'));
  }

  {
    const root = await prepareRoot('permission-warning-qa-fail');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const engine = new SelfHealingEngine(config(root, { maxLoops: 1 }), {
      analyzer: {
        analyze: async () => ({
          summary: 'permission warning fails QA',
          likelyCause: 'OpenCode touched source but QA still fails',
          affectedFiles: ['src/permission-warning-fail.ts'],
          fixStrategy: 'rollback after max loops',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyBugFix: async ({ patchApplier, openCodeState }) => {
          openCodeState.lastErrorType = 'permission-warning';
          openCodeState.lastError = 'OpenCode permission rejected after changing files';
          return patchApplier.applyAll([
            { path: 'src/permission-warning-fail.ts', action: 'create', content: 'export const broken = true;\n' },
          ]);
        },
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 1, '', 'still failing')],
      },
    });

    const run = await engine.run({ userInput: 'fix with permission warning but failing QA', source: 'system' });
    assert.equal(run.status, 'rolled_back');
    await assert.rejects(() => fs.access(path.join(root, 'src', 'permission-warning-fail.ts')));
  }

  {
    const root = await prepareRoot('auto-apply-disabled');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    let applyCalls = 0;
    const engine = new SelfHealingEngine(config(root, { autoApply: false }), {
      analyzer: {
        analyze: async () => ({
          summary: 'analysis only',
          likelyCause: 'bug found',
          affectedFiles: ['src/should-not-change.ts'],
          fixStrategy: 'would patch if autoApply were enabled',
          confidence: 0.8,
        }),
      },
      codingAgent: {
        applyBugFix: async () => {
          applyCalls += 1;
          throw new Error('coding agent must not be called when autoApply=false');
        },
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 0, 'ok', '')],
      },
    });

    const run = await engine.run({ userInput: 'analyze without applying', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.equal(applyCalls, 0);
    assert.deepEqual(run.loops[0].changedFiles, []);
    await assert.rejects(
      () => fs.readFile(path.join(root, 'src', 'should-not-change.ts'), 'utf-8'),
      /ENOENT/
    );
  }

  {
    const root = await prepareRoot('auto-install-disabled');
    let installCalls = 0;
    const engine = new SelfHealingEngine(config(root, {
      autoInstall: false,
      maxLoops: 1,
      autoRollback: false,
    }), {
      analyzer: {
        analyze: async () => ({
          summary: 'missing dep',
          likelyCause: 'package missing',
          affectedFiles: [],
          fixStrategy: 'install package',
          confidence: 0.8,
        }),
      },
      codingAgent: { applyBugFix: async () => [] },
      dependencyResolver: {
        install: async () => {
          installCalls += 1;
          throw new Error('dependency install must not be called when autoInstall=false');
        },
      },
      testRunner: {
        runAll: async () => [
          commandResult('npm run build', 1, '', "Cannot find module 'axios'"),
        ],
      },
    });

    const run = await engine.run({ userInput: 'fix missing dependency without install', source: 'system' });
    assert.equal(run.status, 'failed');
    assert.equal(installCalls, 0);
    assert.equal(run.loops[0].qaReport.nextAction, 'install_dependency');
    assert.deepEqual(run.loops[0].missingPackages, ['axios']);
    assert.match(run.loops[0].error, /autoInstall=false/);
    const report = await engine.getReport(run.id);
    assert.match(report ?? '', /autoInstall=false/);
  }

  {
    const root = await prepareRoot('rollback');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'broken.ts'), 'export const value = 1;\n');
    const engine = new SelfHealingEngine(config(root, { maxLoops: 2 }), {
      analyzer: {
        analyze: async () => ({
          summary: 'bug',
          likelyCause: 'bad value',
          affectedFiles: ['src/broken.ts'],
          fixStrategy: 'change value',
          confidence: 0.8,
        }),
      },
      codingAgent: {
        applyBugFix: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/broken.ts', action: 'update', content: 'export const value = 2;\n' },
        ]),
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 1, '', 'still failing')],
      },
    });

    const run = await engine.run({ userInput: 'fix but fail', source: 'system' });
    assert.equal(run.status, 'rolled_back');
    assert.equal(await fs.readFile(path.join(root, 'src', 'broken.ts'), 'utf-8'), 'export const value = 1;\n');
    assert.match(run.fileDiffs?.[0]?.diffText ?? '', /\+export const value = 2/);
    const report = await engine.getReport(run.id);
    assert.match(report ?? '', /Rollback status/);
    assert.match(report ?? '', /\+export const value = 2/);
  }

  {
    const root = await prepareRoot('unsafe');
    const snapshot = new SnapshotManager(root, path.join(root, 'snap'));
    const applier = new PatchApplier(root, snapshot);
    await assert.rejects(
      () => applier.applyPatch({ path: '.env', action: 'update', content: 'SECRET=x\n' }),
      /Blocked secret file/
    );
    assert.equal(SafetyPolicy.isSafePackageName('lodash-es'), true);
    assert.equal(SafetyPolicy.isSafePackageName('bad && rm'), false);
  }

  {
    const redacted = redactSecrets('Authorization: Bearer abcdefghijklmnop OPENAI_API_KEY=sk-secret1234');
    assert(!redacted.includes('abcdefghijklmnop'));
    assert(!redacted.includes('sk-secret1234'));
  }

  {
    const redacted = redactSecrets([
      'DATABASE_URL=postgresql://user:supersecretpass@localhost:5432/db',
      'mysql://root:pass@localhost:3306/db',
      'mongodb://user:pass@localhost:27017/db',
      'redis://default:pass@localhost:6379',
      'http://user:pass@example.com/path',
      'https://user:pass@example.com/path',
    ].join('\n'));
    assert.match(redacted, /postgresql:\/\/user:\[REDACTED\]@localhost:5432\/db/);
    assert.match(redacted, /mysql:\/\/root:\[REDACTED\]@localhost:3306\/db/);
    assert.match(redacted, /mongodb:\/\/user:\[REDACTED\]@localhost:27017\/db/);
    assert.match(redacted, /redis:\/\/default:\[REDACTED\]@localhost:6379/);
    assert.match(redacted, /http:\/\/user:\[REDACTED\]@example.com\/path/);
    assert.match(redacted, /https:\/\/user:\[REDACTED\]@example.com\/path/);
    assert(!redacted.includes('supersecretpass'));
  }

  {
    const source = [
      'const token = accessToken; // use the token',
      'const password = user.password;',
      'let apiKey = config.apiKey;',
      'token: token',
      'password: password',
    ].join('\n');
    assert.equal(redactSecrets(source), source);
  }

  {
    const redacted = redactSecrets([
      'API_KEY=sk-proj-abcdef1234567890',
      'BREVO_API_KEY=xkeysib-abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'password=supersecret123',
    ].join('\n'));
    assert(!redacted.includes('sk-proj-abcdef1234567890'));
    assert(!redacted.includes('xkeysib-abcdefghijklmnopqrstuvwxyz'));
    assert(!redacted.includes('Bearer abcdefghijklmnopqrstuvwxyz'));
    assert(!redacted.includes('supersecret123'));
    assert.match(redacted, /API_KEY=\[REDACTED/);
  }

  {
    const qa = new QAAgent().analyze([
      commandResult('npm run build', 1, '', "error TS2307: Cannot find module 'lodash-es'"),
    ]);
    assert.equal(qa.nextAction, 'install_dependency');
    assert.deepEqual(qa.missingPackages, ['lodash-es']);
  }

  {
    const root = await prepareRoot('upgrade');
    await fs.mkdir(path.join(root, 'src', 'tools'), { recursive: true });
    const engine = new SelfUpgradeEngine({
      ...config(root),
      autoRegister: true,
      allowedTargets: ['repo'],
    }, {
      analyzer: {
        analyzeUpgrade: async () => ({
          summary: 'add tool',
          missingCapability: 'slugify',
          feasible: true,
          targetFiles: ['src/tools/text-slugify.ts'],
          implementationStrategy: 'create tool',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyUpgrade: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/tools/text-slugify.ts', action: 'create', content: 'export function slugify(x) { return x.toLowerCase(); }\n' },
        ]),
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 0, 'ok', '')],
      },
    });

    const run = await engine.run({ userInput: 'add slugify tool', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.match(await fs.readFile(path.join(root, 'src', 'tools', 'text-slugify.ts'), 'utf-8'), /slugify/);
  }

  {
    const envKeys = [
      'OPENCODE_AGENT_ENABLED',
      'OPENCODE_AGENT_COMMAND',
      'OPENCODE_AGENT_CWD',
      'OPENCODE_AUTO_INSTALL',
      'OPENCODE_AUTH_BOOTSTRAP',
      'OPENCODE_AGENT_USE_FOR_SELF_HEALING',
    ];
    const savedEnv = saveEnv(envKeys);
    try {
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = `missing-opencode-${Date.now()}`;
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'false';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';

      const root = await prepareRoot('healing-opencode-unavailable');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      let providerCalls = 0;
      let qaCalls = 0;
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
                    path: 'src/opencode-unavailable.ts',
                    action: 'create',
                    content: `export const loop = ${providerCalls};\n`,
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const engine = new SelfHealingEngine(config(root), {
        provider,
        analyzer: {
          analyze: async () => ({
            summary: 'bug',
            likelyCause: 'fixture fails',
            affectedFiles: ['src/opencode-unavailable.ts'],
            fixStrategy: 'use fallback provider',
            confidence: 0.9,
          }),
        },
        testRunner: {
          runAll: async () => {
            qaCalls += 1;
            return qaCalls === 1
              ? [commandResult('npm run build', 1, '', 'still failing')]
              : [commandResult('npm run build', 0, 'ok', '')];
          },
        },
      });

      const run = await engine.run({ userInput: 'fix with opencode unavailable', source: 'system' });
      assert.equal(run.status, 'passed');
      assert.equal(providerCalls, 2);
      assert.equal(run.openCodeAttempted, true);
      assert.equal(run.openCodeAttempts, 1);
      assert.equal(run.opencodeUnavailable, true);
      assert.equal(run.openCodeFallbackUsed, true);
      assert.match(run.opencodeUnavailableReason, /not installed|ENOENT|not found|not recognized|EPERM/i);
      assert.match(run.finalSummary, /OpenCode was attempted but unavailable/);
      assert.match(run.finalSummary, /internal CodingAgent fallback was used/);
    } finally {
      restoreSavedEnv(savedEnv);
    }
  }

  {
    const envKeys = [
      'OPENCODE_AGENT_ENABLED',
      'OPENCODE_AGENT_COMMAND',
      'OPENCODE_AGENT_CWD',
      'OPENCODE_AUTO_INSTALL',
      'OPENCODE_AUTH_BOOTSTRAP',
      'OPENCODE_AGENT_USE_FOR_SELF_UPGRADE',
    ];
    const savedEnv = saveEnv(envKeys);
    try {
      process.env.OPENCODE_AGENT_ENABLED = 'true';
      process.env.OPENCODE_AGENT_COMMAND = `missing-opencode-${Date.now()}`;
      process.env.OPENCODE_AGENT_CWD = '';
      process.env.OPENCODE_AUTO_INSTALL = 'false';
      process.env.OPENCODE_AUTH_BOOTSTRAP = 'false';
      process.env.OPENCODE_AGENT_USE_FOR_SELF_UPGRADE = 'true';

      const root = await prepareRoot('upgrade-opencode-unavailable');
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      let providerCalls = 0;
      let qaCalls = 0;
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
                    path: 'src/opencode-upgrade-unavailable.ts',
                    action: 'create',
                    content: `export const upgradeLoop = ${providerCalls};\n`,
                  },
                ],
              }),
            },
            model: 'mock',
            latencyMs: 1,
          };
        },
      };
      const engine = new SelfUpgradeEngine({
        ...config(root),
        autoRegister: true,
        allowedTargets: ['repo'],
      }, {
        provider,
        analyzer: {
          analyzeUpgrade: async () => ({
            summary: 'upgrade',
            missingCapability: 'fixture upgrade',
            feasible: true,
            targetFiles: ['src/opencode-upgrade-unavailable.ts'],
            implementationStrategy: 'use fallback provider',
            confidence: 0.9,
          }),
        },
        testRunner: {
          runAll: async () => {
            qaCalls += 1;
            return qaCalls === 1
              ? [commandResult('npm run build', 1, '', 'still failing')]
              : [commandResult('npm run build', 0, 'ok', '')];
          },
        },
      });

      const run = await engine.run({ userInput: 'upgrade with opencode unavailable', source: 'system' });
      assert.equal(run.status, 'passed');
      assert.equal(providerCalls, 2);
      assert.equal(run.openCodeAttempted, true);
      assert.equal(run.openCodeAttempts, 1);
      assert.equal(run.opencodeUnavailable, true);
      assert.equal(run.openCodeFallbackUsed, true);
      assert.match(run.finalSummary, /OpenCode was attempted but unavailable/);
    } finally {
      restoreSavedEnv(savedEnv);
    }
  }

  {
    const root = await prepareRoot('upgrade-restart');
    await fs.mkdir(path.join(root, 'src', 'tools'), { recursive: true });
    const lifecycle = fakeLifecycle();
    const engine = new SelfUpgradeEngine({
      ...config(root, { autoRestart: true }),
      autoRegister: true,
      allowedTargets: ['repo'],
    }, {
      lifecycleManager: lifecycle.manager,
      analyzer: {
        analyzeUpgrade: async () => ({
          summary: 'add tool',
          missingCapability: 'restartable tool',
          feasible: true,
          targetFiles: ['src/tools/restartable-tool.ts'],
          implementationStrategy: 'create tool',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyUpgrade: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/tools/restartable-tool.ts', action: 'create', content: 'export const restartable = true;\n' },
        ]),
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 0, 'ok', '')],
      },
    });

    const run = await engine.run({ userInput: 'add restartable tool', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.equal(run.restartRequired, true);
    assert.equal(run.restartScheduled, true);
    assert.equal(lifecycle.calls.schedules, 1);
    assert.match(run.finalSummary, /Auto restart scheduled/);
  }

  {
    const root = await prepareRoot('upgrade-no-restart-disabled');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const lifecycle = fakeLifecycle();
    const engine = new SelfUpgradeEngine({
      ...config(root, { autoRestart: false }),
      autoRegister: true,
      allowedTargets: ['repo'],
    }, {
      lifecycleManager: lifecycle.manager,
      analyzer: {
        analyzeUpgrade: async () => ({
          summary: 'add source file',
          missingCapability: 'source change',
          feasible: true,
          targetFiles: ['src/source-change.ts'],
          implementationStrategy: 'create source file',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyUpgrade: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/source-change.ts', action: 'create', content: 'export const sourceChange = true;\n' },
        ]),
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 0, 'ok', '')],
      },
    });

    const run = await engine.run({ userInput: 'add source file', source: 'system' });
    assert.equal(run.status, 'passed');
    assert.equal(run.restartRequired, true);
    assert.equal(run.restartScheduled, false);
    assert.equal(lifecycle.calls.schedules, 0);
  }

  {
    const root = await prepareRoot('upgrade-failed-no-restart');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const lifecycle = fakeLifecycle();
    const engine = new SelfUpgradeEngine({
      ...config(root, { maxLoops: 1, autoRestart: true }),
      autoRegister: true,
      allowedTargets: ['repo'],
    }, {
      lifecycleManager: lifecycle.manager,
      analyzer: {
        analyzeUpgrade: async () => ({
          summary: 'bad upgrade',
          missingCapability: 'broken source',
          feasible: true,
          targetFiles: ['src/broken-upgrade.ts'],
          implementationStrategy: 'create broken source',
          confidence: 0.9,
        }),
      },
      codingAgent: {
        applyUpgrade: async ({ patchApplier }) => patchApplier.applyAll([
          { path: 'src/broken-upgrade.ts', action: 'create', content: 'export const broken = true;\n' },
        ]),
      },
      testRunner: {
        runAll: async () => [commandResult('npm run build', 1, '', 'still failing')],
      },
    });

    const run = await engine.run({ userInput: 'add broken source', source: 'system' });
    assert.equal(run.status, 'rolled_back');
    assert.equal(run.restartScheduled ?? false, false);
    assert.equal(lifecycle.calls.schedules, 0);
  }

  {
    const lifecycle = fakeLifecycle({ isTestRuntime: true });
    lifecycle.manager.requestRestart({ reason: 'test runtime' });
    assert.equal(lifecycle.manager.isRestartScheduled(), false);
    assert.equal(lifecycle.calls.schedules, 0);
  }

  {
    const lifecycle = fakeLifecycle();
    lifecycle.manager.requestRestart({ reason: 'first' });
    lifecycle.manager.requestRestart({ reason: 'second' });
    assert.equal(lifecycle.manager.isRestartScheduled(), true);
    assert.equal(lifecycle.calls.schedules, 1);
  }

  {
    assert.equal(isRestartRequiredForChangedFiles(['src/tools/new-tool.ts'], 'self-upgrade'), true);
    assert.equal(isRestartRequiredForChangedFiles(['src/agents/orchestrator.ts'], 'self-upgrade'), true);
    assert.equal(isRestartRequiredForChangedFiles(['README.md'], 'self-upgrade'), false);
    assert.equal(isRestartRequiredForChangedFiles(['src/index.ts'], 'self-healing'), true);
    assert.equal(isRestartRequiredForChangedFiles(['src/config/env.ts'], 'self-healing'), true);
    assert.equal(isRestartRequiredForChangedFiles(['src/agents/orchestrator.ts'], 'self-healing'), false);
    assert.deepEqual(filterRestartRelevantChangedFiles([
      '.data-test-run/session.json',
      'data/test-run/output.json',
      'coverage/lcov.info',
      'dist/index.js',
      'node_modules/pkg/index.js',
      'runtime.log',
      'src/tools/new-tool.ts',
    ]), ['src/tools/new-tool.ts']);
    assert.equal(isRestartRequiredForChangedFiles(['.data-test-run/session.json'], 'self-upgrade'), false);
    assert.equal(isRestartRequiredForChangedFiles(['runtime.log'], 'self-healing'), false);
  }

  {
    const root = await prepareRoot('legacy-upgrade-npm-view-fails');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { '@openclaw/core': '1.0.0' },
    }));
    await fs.writeFile(path.join(root, 'src', 'index.ts'), 'console.log("ok");\n');

    const childProcess = require('node:child_process');
    const originalExecSync = childProcess.execSync;
    const originalCwd = process.cwd();
    try {
      childProcess.execSync = () => {
        throw new Error('network unavailable');
      };
      process.chdir(root);
      delete require.cache[require.resolve('../dist/core/selfUpgrade')];
      const { performSelfUpgrade } = require('../dist/core/selfUpgrade');
      const result = await performSelfUpgrade({ dryRun: true });
      assert.equal(result, 'Could not fetch latest @openclaw/core version from npm registry.');
    } finally {
      process.chdir(originalCwd);
      childProcess.execSync = originalExecSync;
      delete require.cache[require.resolve('../dist/core/selfUpgrade')];
    }
  }

  {
    const root = await prepareRoot('legacy-upgrade-missing-index');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { '@openclaw/core': '1.0.0' },
    }));

    const childProcess = require('node:child_process');
    const originalExecSync = childProcess.execSync;
    const originalCwd = process.cwd();
    try {
      childProcess.execSync = (command) => {
        if (String(command).includes('npm view')) return '1.0.1';
        throw new Error(`unexpected command: ${command}`);
      };
      process.chdir(root);
      delete require.cache[require.resolve('../dist/core/selfUpgrade')];
      const { performSelfUpgrade } = require('../dist/core/selfUpgrade');
      const result = await performSelfUpgrade();
      assert.equal(result, 'Could not perform self-upgrade: src/index.ts was not found.');
    } finally {
      process.chdir(originalCwd);
      childProcess.execSync = originalExecSync;
      delete require.cache[require.resolve('../dist/core/selfUpgrade')];
    }
  }

  console.log('self-healing tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
