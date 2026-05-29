const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');

const {
  PatchApplier,
  QAAgent,
  SafetyPolicy,
  SelfHealingEngine,
  SelfUpgradeEngine,
  SnapshotManager,
  redactSecrets,
} = require('../dist/self-healing');

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
    ...overrides,
  };
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

  console.log('self-healing tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
