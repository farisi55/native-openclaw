/**
 * test/scheduler-qa.test.js
 * QA regression suite for scheduler intent parsing.
 * Run: node test/scheduler-qa.test.js after npm run build.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.SCHEDULER_TIMEZONE = 'Asia/Jakarta';

const {
  looksLikeSchedulerRequest,
  parseSchedulerIntent,
} = require('../dist/scheduler');

const NOW = new Date('2026-05-28T03:54:00.000Z');

function parsed(input) {
  return parseSchedulerIntent(input, { now: NOW, timezone: 'Asia/Jakarta' });
}

function assertDelay(input, expectedMs, toleranceMs = 2000) {
  const intent = parsed(input);
  assert.ok(intent.runAt, `Expected runAt to be set for: "${input}"`);
  const actual = new Date(intent.runAt).getTime() - NOW.getTime();
  const diff = Math.abs(actual - expectedMs);
  assert.ok(
    diff <= toleranceMs,
    `Delay mismatch for "${input}": expected ~${expectedMs}ms, got ${actual}ms (diff ${diff}ms)`
  );
}

function assertLooks(input, expected) {
  const got = looksLikeSchedulerRequest(input);
  assert.equal(got, expected, `looksLikeSchedulerRequest("${input}") should be ${expected}`);
}

function assertIntent(input, expectedIntent) {
  const intent = parsed(input);
  assert.equal(intent.intent, expectedIntent, `intent for "${input}" should be "${expectedIntent}"`);
}

test('[CJ-01] kirimkan saya harga emas 5 menit lagi ke email', () => {
  const input = 'kirimkan saya harga emas 5 menit lagi ke email';
  assertLooks(input, true);
  assertIntent(input, 'create');
  assertDelay(input, 5 * 60_000);
});

test('[CJ-02] ingatkan saya meeting jam 15:00', () => {
  const input = 'ingatkan saya meeting jam 15:00';
  assertLooks(input, true);
  assertIntent(input, 'create');
});

test('[CJ-03] jadwalkan kirim berita setiap hari jam 08:00', () => {
  const input = 'jadwalkan kirim berita setiap hari jam 08:00';
  assertLooks(input, true);
  assertIntent(input, 'create');
});

test('[CJ-06] coba balas pesan ini 2 menit lagi', () => {
  const input = 'coba balas pesan ini 2 menit lagi';
  assertLooks(input, true);
  assertDelay(input, 2 * 60_000);
});

test('[CJ-07] balas hai juga setelah 30 detik kemudian', () => {
  const input = 'balas hai juga setelah 30 detik kemudian';
  assertLooks(input, true);
  assertIntent(input, 'create');
  assertDelay(input, 30_000);
});

test('[CJ-08] saya ingin dikirimkan harga emas 5 menit dari sekarang ke email', () => {
  const input = 'saya ingin dikirimkan harga emas 5 menit dari sekarang ke email';
  assertLooks(input, true);
  assertDelay(input, 5 * 60_000);
});

test('[CJ-09] nanti kamu kirim ya laporan harian ke email', () => {
  assertLooks('nanti kamu kirim ya laporan harian ke email', true);
});

test('[CJ-13] dalam 10 menit kirim email ke saya', () => {
  const input = 'dalam 10 menit kirim email ke saya';
  assertLooks(input, true);
  assertDelay(input, 10 * 60_000);
});

test('[CJ-14] send me gold price in 5 minutes', () => {
  const input = 'send me gold price in 5 minutes';
  assertLooks(input, true);
  assertDelay(input, 5 * 60_000);
});

test('[AL-01] bangunkan saya jam 06:00', () => {
  assertLooks('bangunkan saya jam 06:00', true);
});

test('[AL-02] bangunkan saya besok jam 7', () => {
  assertLooks('bangunkan saya besok jam 7', true);
});

test('[AL-03] set alarm jam 08:30 besok', () => {
  assertLooks('set alarm jam 08:30 besok', true);
});

test('[AL-04] wake me up at 5am should not trigger', () => {
  assertLooks('wake me up at 5am', false);
});

test('[DR-01] balas hai juga setelah 30 detik kemudian', () => {
  const input = 'balas hai juga setelah 30 detik kemudian';
  assertLooks(input, true);
  assertDelay(input, 30_000);
});

test('[DR-03] balas pesan ini 2 menit kemudian dengan ok siap', () => {
  const input = 'balas pesan ini 2 menit kemudian dengan ok siap';
  assertLooks(input, true);
  assertDelay(input, 2 * 60_000);
});

test('[DR-04] jawab dengan halo 5 detik lagi should not trigger', () => {
  assertLooks('jawab dengan halo 5 detik lagi', false);
});

test('[DR-05] in 30 seconds reply hi back', () => {
  const input = 'in 30 seconds reply hi back';
  assertLooks(input, true);
  assertDelay(input, 30_000);
});

test('[FU-02] follow up email ini besok', () => {
  assertLooks('follow up email ini besok', true);
});

test('[FU-03] kabari saya nanti soal update project', () => {
  assertLooks('kabari saya nanti soal update project', true);
});

test('[PR-01] kirimkan berita setiap jam', () => {
  assertLooks('kirimkan berita setiap jam', true);
});

test('[PR-04] ingatkan saya setiap senin', () => {
  assertLooks('ingatkan saya setiap senin', true);
});

test('[TF-01] kirim email 15 detik dari sekarang', () => {
  const input = 'kirim email 15 detik dari sekarang';
  assertLooks(input, true);
  assertDelay(input, 15_000);
});

test('[TF-02] reminder dalam 45 menit', () => {
  const input = 'reminder dalam 45 menit';
  assertLooks(input, true);
  assertDelay(input, 45 * 60_000);
});

test('[TF-03] after 2 hours send report', () => {
  const input = 'after 2 hours send report';
  assertLooks(input, true);
  assertDelay(input, 2 * 60 * 60_000);
});

test('[TF-04] send in 90 seconds', () => {
  const input = 'send in 90 seconds';
  assertLooks(input, true);
  assertDelay(input, 90_000);
});

test('[SI-08] nanti kamu kirim ya laporan ke email', () => {
  assertLooks('nanti kamu kirim ya laporan ke email', true);
});

test('[SI-09] bangunkan saya jam 07:00', () => {
  assertLooks('bangunkan saya jam 07:00', true);
});

test('[SI-10] balas email nanti jam 14:00', () => {
  assertLooks('balas email nanti jam 14:00', true);
});

test('[SI-11] tolong ingatkan hari ini jam 15:00', () => {
  assertLooks('tolong ingatkan hari ini jam 15:00', true);
});

test('[SI-12] set alarm jam 08:00', () => {
  assertLooks('set alarm jam 08:00', true);
});

test('[SI-13] kabari saya nanti jam 10:00', () => {
  assertLooks('kabari saya nanti jam 10:00', true);
});

test('[SI-14] follow up email ini besok pagi', () => {
  assertLooks('follow up email ini besok pagi', true);
});

test('[FP-01] ping me in 15 minutes should not trigger', () => {
  assertLooks('ping me in 15 minutes', false);
});

test('[FP-04] film ini berdurasi 2 jam should not trigger', () => {
  assertLooks('film ini berdurasi 2 jam', false);
});

test('[EC-01] apa harga emas hari ini should not trigger', () => {
  assertLooks('apa harga emas hari ini', false);
});

test('[EC-02] jelaskan cara membuat kopi should not trigger', () => {
  assertLooks('jelaskan cara membuat kopi', false);
});

test('[PC-01] harga emas email prompt includes brevo-email reference', () => {
  const intent = parsed('kirimkan harga emas 5 menit lagi ke email');
  assert.match(intent.prompt ?? '', /brevo-email/i);
});

test('[PC-02] balas hai prompt includes reply instruction', () => {
  const intent = parsed('balas hai juga setelah 30 detik kemudian');
  assert.match(intent.prompt ?? '', /balas/i);
});

test('[PC-03] arsenal email prompt includes brevo-email reference', () => {
  const intent = parsed('kirimkan berita arsenal 2 menit lagi ke email');
  assert.match(intent.prompt ?? '', /brevo-email/i);
});

test('[MG-01] list intent', () => {
  assertIntent('lihat semua cronjob', 'list');
  assertIntent('list cronjob aktif', 'list');
});

test('[MG-02] delete intent', () => {
  assertIntent('hapus cronjob report-harga-emas', 'delete');
});

test('[MG-03] disable intent', () => {
  assertIntent('disable cronjob berita-arsenal', 'disable');
});
