const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');

const {
  SelfImprovingEngine,
  SkillEvaluator,
  SkillExtractor,
  SkillQualityTracker,
  SkillRegistry,
  SkillWriter,
  handleSelfImprovingAction,
} = require('../dist/skills');

function providerReturning(contentOrFactory) {
  let callCount = 0;
  return {
    id: 'mock',
    displayName: 'Mock Provider',
    async listModels() {
      return [{
        id: 'mock-model',
        name: 'Mock Model',
        contextWindow: 8192,
        supportsTools: false,
        supportsVision: false,
      }];
    },
    async chat(options) {
      const content = typeof contentOrFactory === 'function'
        ? contentOrFactory(callCount++, options)
        : contentOrFactory;
      return {
        message: { role: 'assistant', content },
        model: 'mock-model',
        latencyMs: 1,
      };
    },
  };
}

function extractionJson(name = 'Research and Email Summary') {
  return JSON.stringify({
    shouldExtract: true,
    name,
    description: 'Use when researching a topic and emailing a concise summary.',
    tags: ['research', 'email'],
    body: '1. Search trusted sources.\n2. Summarize findings.\n3. Send the summary with the email tool.',
  });
}

function noExtractionJson() {
  return JSON.stringify({ shouldExtract: false });
}

async function createParts(root, provider = providerReturning(extractionJson())) {
  const skillsBaseDir = join(root, 'skills');
  const autoSkillsDir = join(skillsBaseDir, 'auto-generated');
  const dataDir = join(root, 'data');
  const extractor = new SkillExtractor(provider);
  const writer = new SkillWriter(autoSkillsDir);
  const tracker = new SkillQualityTracker(dataDir, 10);
  const evaluator = new SkillEvaluator(provider, writer, tracker);
  const registry = new SkillRegistry();
  const engine = new SelfImprovingEngine(extractor, writer, tracker, evaluator, registry, skillsBaseDir);
  await tracker.load();
  return { skillsBaseDir, autoSkillsDir, dataDir, provider, extractor, writer, tracker, evaluator, registry, engine };
}

async function withTemp(testFn) {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-self-improving-'));
  try {
    await testFn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeAutoSkill(filePath, name, body = 'Original body.') {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, [
    '---',
    `name: ${name}`,
    `description: ${name} description`,
    'version: 1.0.0',
    'tags: [auto]',
    'priority: 5',
    'enabled: true',
    'auto_generated: true',
    `created_at: ${new Date().toISOString()}`,
    'usage_count: 0',
    'success_rate: 1.0',
    '---',
    '',
    body,
    '',
  ].join('\n'), 'utf-8');
}

test('self-improving uses configured paths and registers new skills with zero usage', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root);

    await parts.engine.processCompletedTurn({
      userInput: 'Cari berita Arsenal dan kirim ringkasannya ke email saya.',
      agentResponse: 'Ringkasan sudah dikirim.',
      toolsUsed: ['web-fetch', 'brevo-email'],
      stepCount: 2,
      sessionId: 'test-session',
    });

    const files = await parts.writer.listAutoSkills();
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith(parts.autoSkillsDir));
    assert.equal(parts.registry.size, 1);
    assert.equal(parts.registry.activeSkills()[0]?.name, 'Research and Email Summary');

    const quality = JSON.parse(await readFile(join(parts.dataDir, 'skill-quality.json'), 'utf-8'));
    const entries = Object.values(quality.skills);
    assert.equal(quality.taskCounter, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].usageCount, 0);
    assert.equal(entries[0].successCount, 0);
  });
});

test('simple Q&A is not extracted', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root);
    await parts.engine.processCompletedTurn({
      userInput: 'Apa itu TypeScript?',
      agentResponse: 'TypeScript adalah superset JavaScript.',
      toolsUsed: [],
      stepCount: 0,
      sessionId: 'simple',
    });

    assert.equal((await parts.writer.listAutoSkills()).length, 0);
    const quality = JSON.parse(await readFile(join(parts.dataDir, 'skill-quality.json'), 'utf-8'));
    assert.equal(quality.taskCounter, 1);
  });
});

test('duplicate extracted skills are skipped', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root);
    const input = {
      userInput: 'Cari berita dan kirim email.',
      agentResponse: 'Selesai.',
      toolsUsed: ['web-fetch', 'brevo-email'],
      stepCount: 2,
      sessionId: 'dup',
    };

    await parts.engine.processCompletedTurn(input);
    await parts.engine.processCompletedTurn(input);

    assert.equal((await parts.writer.listAutoSkills()).length, 1);
    assert.equal(parts.registry.size, 1);
  });
});

test('scheduler action phrase can be extracted even with no tools', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root, providerReturning(extractionJson('Informal Scheduler Phrase')));

    await parts.engine.processCompletedTurn({
      userInput: 'nanti kamu kirim ya laporan ke email',
      agentResponse: 'Cronjob dibuat.',
      toolsUsed: [],
      stepCount: 0,
      sessionId: 'scheduler',
      wasSchedulerAction: true,
    });

    const files = await parts.writer.listAutoSkills();
    assert.equal(files.length, 1);
    assert.equal(parts.registry.activeSkills()[0]?.name, 'Informal Scheduler Phrase');
  });
});

test('failed scheduled job records task but does not extract success skill', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root, providerReturning(extractionJson('Should Not Be Written')));

    await parts.engine.processCompletedTurn({
      userInput: 'kirimkan saya berita arsenal ke email saya',
      agentResponse: 'Email was not sent.',
      toolsUsed: ['web-fetch', 'brevo-email'],
      stepCount: 2,
      source: 'scheduler',
      success: false,
      wasSchedulerAction: true,
      scheduledJobId: 'job-1',
      scheduledJobName: 'berita-arsenal-email',
      emailRequired: true,
      emailSent: false,
      error: 'fetch failed',
    });

    assert.equal((await parts.writer.listAutoSkills()).length, 0);
    const quality = JSON.parse(await readFile(join(parts.dataDir, 'skill-quality.json'), 'utf-8'));
    assert.equal(quality.taskCounter, 1);
    assert.equal(Object.keys(quality.skills).length, 0);
  });
});

test('invalid extractor JSON does not crash or write skills', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root, providerReturning('not valid json'));

    await parts.engine.processCompletedTurn({
      userInput: 'Cari data lalu proses.',
      agentResponse: 'Selesai.',
      toolsUsed: ['web-fetch'],
      stepCount: 2,
      sessionId: 'bad-json',
    });

    assert.equal((await parts.writer.listAutoSkills()).length, 0);
    const quality = JSON.parse(await readFile(join(parts.dataDir, 'skill-quality.json'), 'utf-8'));
    assert.equal(quality.taskCounter, 1);
  });
});

test('quality tracker persistence failure does not crash self-improvement turn processing', async () => {
  await withTemp(async (root) => {
    const skillsBaseDir = join(root, 'skills');
    const autoSkillsDir = join(skillsBaseDir, 'auto-generated');
    const blockedDataDir = join(root, 'blocked-data');
    await writeFile(blockedDataDir, 'not a directory', 'utf-8');

    const provider = providerReturning(noExtractionJson());
    const extractor = new SkillExtractor(provider);
    const writer = new SkillWriter(autoSkillsDir);
    const tracker = new SkillQualityTracker(blockedDataDir, 10);
    const evaluator = new SkillEvaluator(provider, writer, tracker);
    const registry = new SkillRegistry();
    const engine = new SelfImprovingEngine(extractor, writer, tracker, evaluator, registry, skillsBaseDir);

    await assert.doesNotReject(() => engine.processCompletedTurn({
      userInput: 'Catat tugas ini.',
      agentResponse: 'Selesai.',
      toolsUsed: [],
      stepCount: 0,
      sessionId: 'persist-failure',
    }));
    assert.equal((await writer.listAutoSkills()).length, 0);
  });
});

test('active skill usage is tracked for skills injected before a turn', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root, providerReturning(noExtractionJson()));
    const activeSkill = {
      id: 'auto-existing-skill',
      name: 'Existing Auto Skill',
      filePath: join(parts.autoSkillsDir, 'auto-existing-skill.md'),
    };

    await parts.engine.processCompletedTurn({
      userInput: 'Gunakan skill ini untuk riset.',
      agentResponse: 'Selesai.',
      toolsUsed: ['web-fetch'],
      stepCount: 2,
      sessionId: 'active',
      activeSkillsUsed: [activeSkill],
    });

    const stats = parts.tracker.getSkillStats(activeSkill.id);
    assert.equal(stats.usageCount, 1);
    assert.equal(stats.successCount, 1);
    assert.equal(stats.failureCount, 0);
    assert.equal(parts.tracker.getTaskCounter(), 1);
  });
});

test('low-success auto-generated skill is improved', async () => {
  await withTemp(async (root) => {
    const provider = providerReturning('Improved body with clearer numbered steps and failure handling.');
    const parts = await createParts(root, provider);
    const filePath = join(parts.autoSkillsDir, 'auto-low-success.md');
    await writeAutoSkill(filePath, 'Low Success Skill');
    await parts.registry.load({ skillsDir: parts.skillsBaseDir });
    await parts.tracker.registerSkill('auto-low-success', 'Low Success Skill', filePath);
    await parts.tracker.recordSkillUsage('auto-low-success', 'Low Success Skill', filePath, false);
    await parts.tracker.recordSkillUsage('auto-low-success', 'Low Success Skill', filePath, false);
    await parts.tracker.recordSkillUsage('auto-low-success', 'Low Success Skill', filePath, true);

    const report = await parts.evaluator.evaluate(parts.registry.all());
    const raw = await readFile(filePath, 'utf-8');

    assert.equal(report.improved, 1);
    assert.match(raw, /Improved body with clearer numbered steps/);
  });
});

test('unused auto-generated skill is disabled after enough tasks', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root, providerReturning('unused'));
    const filePath = join(parts.autoSkillsDir, 'auto-unused.md');
    await writeAutoSkill(filePath, 'Unused Skill');
    await parts.registry.load({ skillsDir: parts.skillsBaseDir });
    await parts.tracker.registerSkill('auto-unused', 'Unused Skill', filePath);
    for (let i = 0; i < 21; i += 1) {
      await parts.tracker.recordTaskCompletion([], true);
    }

    const report = await parts.evaluator.evaluate(parts.registry.all());
    const raw = await readFile(filePath, 'utf-8');

    assert.equal(report.disabled, 1);
    assert.match(raw, /^enabled: false/m);
  });
});

test('/self-improve status and evaluate return observability output', async () => {
  await withTemp(async (root) => {
    const parts = await createParts(root);
    const ctx = {
      enabled: true,
      engine: parts.engine,
      autoSkillsDir: parts.autoSkillsDir,
      qualityFilePath: join(parts.dataDir, 'skill-quality.json'),
      evaluationThreshold: 10,
    };

    const status = await handleSelfImprovingAction('/self-improve status', ctx);
    assert.equal(status.handled, true);
    assert.match(status.response, /enabled: true/);
    assert.match(status.response, /autoSkillsDir:/);
    assert.match(status.response, /taskCounter:/);

    const evaluation = await handleSelfImprovingAction('/self-improve evaluate', ctx);
    assert.equal(evaluation.handled, true);
    assert.match(evaluation.response, /evaluated:/);
    assert.match(evaluation.response, /improved:/);
  });
});

test('/self-improve status explains disabled configuration', async () => {
  const ctx = {
    enabled: false,
    autoSkillsDir: '/skills/auto-generated',
    qualityFilePath: '/data/skill-quality.json',
    evaluationThreshold: 10,
  };

  const result = await handleSelfImprovingAction('/self-improve status', ctx);
  assert.equal(result.handled, true);
  assert.match(result.response, /SELF_IMPROVING=true/);
  assert.match(result.response, /\/skills\/auto-generated/);
});

test('/self-improve status explains enabled-but-not-ready engine state', async () => {
  const ctx = {
    enabled: true,
    autoSkillsDir: '/skills/auto-generated',
    qualityFilePath: '/data/skill-quality.json',
    evaluationThreshold: 10,
  };

  const result = await handleSelfImprovingAction('/self-improve status', ctx);
  assert.equal(result.handled, true);
  assert.match(result.response, /sudah diaktifkan/);
  assert.match(result.response, /engine belum siap/);
  assert.doesNotMatch(result.response, /SELF_IMPROVING=true/);
});
