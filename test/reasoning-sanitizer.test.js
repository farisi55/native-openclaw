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

assert.equal(
  sanitizeFinalAnswer('Analisis: pengguna membutuhkan data real-time.\nHarga emas hari ini adalah $1,950.'),
  'Harga emas hari ini adalah $1,950.',
  'Harus strip "Analisis:" prefix'
);

assert.equal(
  sanitizeFinalAnswer([
    'Observation: user asked about time',
    'Action: call system-time tool',
    '',
    'Jam sekarang adalah 14:30 WIB.',
  ].join('\n')),
  'Jam sekarang adalah 14:30 WIB.',
  'Harus strip ReAct trace'
);

assert.equal(
  sanitizeFinalAnswer('Proses pengambilan keputusan (reasoning) sangat penting dalam AI.'),
  'Proses pengambilan keputusan (reasoning) sangat penting dalam AI.',
  'Tidak boleh strip kalimat valid yang mengandung kata "reasoning"'
);

assert.equal(sanitizeFinalAnswer(''), '', 'Empty string harus return empty');

assert.equal(sanitizeFinalAnswer('   \n\n   '), '   \n\n   ', 'Whitespace-only harus return as-is');

assert.equal(
  sanitizeFinalAnswer('Berikut hasilnya:\n<thought>internal</thought>\nFile ditemukan: 3 item.'),
  'Berikut hasilnya:\n\nFile ditemukan: 3 item.',
  'XML reasoning tags harus dihapus, konten sebelum dan sesudah dipertahankan'
);

const prompt = buildSystemPrompt({
  basePrompt: 'You are helpful.',
  skills: [],
});

assert.match(prompt, /FINAL RESPONSE RULES/);
assert.match(prompt, /never reveal reasoning/);
assert.match(prompt, /halo kamu siapa\?/);

console.log('reasoning-sanitizer tests passed');
