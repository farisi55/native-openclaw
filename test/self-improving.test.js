const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  SelfImprovingEngine,
  SkillEvaluator,
  SkillExtractor,
  SkillQualityTracker,
  SkillRegistry,
  SkillWriter,
} = require('../dist/skills');

function mockProvider() {
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
    async chat() {
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            shouldExtract: true,
            name: 'Research and Email Summary',
            description: 'Use when researching a topic and emailing a concise summary.',
            tags: ['research', 'email'],
            body: '1. Search trusted sources.\n2. Summarize the findings.\n3. Send the summary with the email tool.',
          }),
        },
        model: 'mock-model',
        latencyMs: 1,
      };
    },
  };
}

test('self-improving engine writes and hot-registers extracted skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-self-improving-'));
  try {
    const skillsDir = join(root, 'skills', 'auto-generated');
    const dataDir = join(root, 'data');
    const provider = mockProvider();
    const extractor = new SkillExtractor(provider);
    const writer = new SkillWriter(skillsDir);
    const tracker = new SkillQualityTracker(dataDir, 10);
    const evaluator = new SkillEvaluator(provider, writer, tracker);
    const registry = new SkillRegistry();
    const engine = new SelfImprovingEngine(extractor, writer, tracker, evaluator, registry);

    await tracker.load();
    await engine.processCompletedTurn({
      userInput: 'Cari berita Arsenal dan kirim ringkasannya ke email saya.',
      agentResponse: 'Ringkasan sudah dikirim.',
      toolsUsed: ['web-fetch', 'brevo-email'],
      stepCount: 2,
      sessionId: 'test-session',
    });

    const files = await writer.listAutoSkills();
    assert.equal(files.length, 1);
    assert.equal(registry.size, 1);
    assert.equal(registry.activeSkills()[0]?.name, 'Research and Email Summary');

    const quality = JSON.parse(await readFile(join(dataDir, 'skill-quality.json'), 'utf-8'));
    assert.equal(quality.taskCounter, 1);
    assert.equal(Object.keys(quality.skills).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
