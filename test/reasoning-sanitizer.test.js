const assert = require('node:assert/strict');

const { buildSystemPrompt } = require('../dist/agents/prompt-builder');
const { sanitizeFinalAnswer } = require('../dist/agents/tool-loop');

const leaked = [
  'The user is asking "halo kamu siapa?".',
  'From the memory, my name is "Jarpis".',
  'I should answer in a friendly and helpful manner.',
  'Halo! Nama saya Jarpis. Saya asisten AI yang siap membantu Anda.',
].join('\n');

assert.equal(
  sanitizeFinalAnswer(leaked),
  'Halo! Nama saya Jarpis. Saya asisten AI yang siap membantu Anda.'
);

assert.equal(
  sanitizeFinalAnswer('<analysis>Need to answer identity.</analysis>\nSaya Jarpis.'),
  'Saya Jarpis.'
);

assert.equal(
  sanitizeFinalAnswer('### Reasoning\nNeed a tool.\n\n### Answer\nFolder Download berisi 3 file.'),
  'Folder Download berisi 3 file.'
);

assert.equal(
  sanitizeFinalAnswer('Halo, ada yang bisa saya bantu?'),
  'Halo, ada yang bisa saya bantu?'
);

const prompt = buildSystemPrompt({
  basePrompt: 'You are helpful.',
  skills: [],
});

assert.match(prompt, /FINAL RESPONSE RULES/);
assert.match(prompt, /never reveal reasoning/);
assert.match(prompt, /halo kamu siapa\?/);

console.log('reasoning-sanitizer tests passed');
