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

  console.log('self-healing tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
