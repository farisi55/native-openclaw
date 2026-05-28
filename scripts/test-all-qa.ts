/**
 * scripts/test-all-qa.ts
 * QA verification runner for scheduler intent and timing behavior.
 *
 * Run: npx tsx scripts/test-all-qa.ts
 */

import { looksLikeSchedulerRequest, parseSchedulerIntent } from '../src/scheduler/scheduler-intent';

interface TestCase {
  id: string;
  input: string;
  expectLooksLike: boolean;
  expectIntent?: string;
  expectScheduleType?: string;
  expectDelayMs?: number;
  expectDelayTolerance?: number;
}

const NOW = new Date('2026-05-28T03:54:00.000Z');

const tests: TestCase[] = [
  { id: 'CJ-01', input: 'kirimkan saya harga emas 5 menit lagi ke email', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once' },
  { id: 'CJ-02', input: 'ingatkan saya meeting jam 15:00', expectLooksLike: true, expectIntent: 'create' },
  { id: 'CJ-03', input: 'jadwalkan kirim berita setiap hari jam 08:00', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'daily' },
  { id: 'CJ-04', input: 'buat cronjob untuk kirim email jam 09:00', expectLooksLike: true },
  { id: 'CJ-05', input: 'tolong ingatkan saya ambil obat jam 20:00', expectLooksLike: true, expectIntent: 'create' },
  { id: 'CJ-06', input: 'coba balas pesan ini 2 menit lagi', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once' },
  { id: 'CJ-07', input: 'balas hai juga setelah 30 detik kemudian', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once', expectDelayMs: 30_000, expectDelayTolerance: 5_000 },
  { id: 'CJ-08', input: 'saya ingin dikirimkan harga emas 5 menit dari sekarang ke email', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once' },
  { id: 'CJ-09', input: 'nanti kamu kirim ya laporan harian ke email', expectLooksLike: true, expectIntent: 'create' },
  { id: 'CJ-10', input: 'bangunkan saya jam 07:00 besok', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once' },
  { id: 'CJ-11', input: 'balas email saya nanti jam 14:00', expectLooksLike: true, expectIntent: 'create' },
  { id: 'CJ-12', input: 'set alarm meeting besok jam 09:30', expectLooksLike: true, expectIntent: 'create' },
  { id: 'CJ-13', input: 'dalam 10 menit kirim email ke saya', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once', expectDelayMs: 600_000, expectDelayTolerance: 5_000 },
  { id: 'CJ-14', input: 'send me gold price in 5 minutes', expectLooksLike: true, expectIntent: 'create', expectScheduleType: 'once', expectDelayMs: 300_000, expectDelayTolerance: 5_000 },
  { id: 'CJ-15', input: 'kirim email 5 menit lagi', expectLooksLike: true, expectIntent: 'create', expectDelayMs: 300_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-16', input: 'kirim email 5 menit dari sekarang', expectLooksLike: true, expectDelayMs: 300_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-17', input: 'send email in 5 minutes', expectLooksLike: true, expectDelayMs: 300_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-18', input: 'balas pesan setelah 30 detik', expectLooksLike: true, expectDelayMs: 30_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-19', input: 'ingatkan saya setelah 2 menit', expectLooksLike: true, expectDelayMs: 120_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-20', input: 'dalam 10 menit kirim notifikasi', expectLooksLike: true, expectDelayMs: 600_000, expectDelayTolerance: 1_000 },
  { id: 'CJ-21', input: 'list cronjob', expectLooksLike: true, expectIntent: 'list' },
  { id: 'CJ-22', input: 'lihat semua cronjob', expectLooksLike: true, expectIntent: 'list' },
  { id: 'CJ-23', input: 'hapus cronjob berita-arsenal', expectLooksLike: true, expectIntent: 'delete' },
  { id: 'SI-08', input: 'nanti kamu kirim ya laporan ke email', expectLooksLike: true },
  { id: 'SI-09', input: 'bangunkan saya jam 07:00', expectLooksLike: true },
  { id: 'SI-10', input: 'balas email nanti jam 14:00', expectLooksLike: true },
  { id: 'SI-11', input: 'tolong ingatkan hari ini jam 15:00', expectLooksLike: true },
  { id: 'SI-12', input: 'set alarm jam 08:00', expectLooksLike: true },
  { id: 'SI-13', input: 'kabari saya nanti jam 10:00', expectLooksLike: true },
  { id: 'SI-14', input: 'follow up email ini besok pagi', expectLooksLike: true },
  { id: 'EC-01', input: 'apa harga emas hari ini', expectLooksLike: false },
  { id: 'EC-02', input: 'jelaskan cara membuat kopi', expectLooksLike: false },
];

let passed = 0;
let failed = 0;

console.log('='.repeat(60));
console.log('QA TEST RUNNER - native-openclaw');
console.log('='.repeat(60));
console.log();

for (const tc of tests) {
  const errors: string[] = [];
  const gotLooksLike = looksLikeSchedulerRequest(tc.input);

  if (gotLooksLike !== tc.expectLooksLike) {
    errors.push(`looksLike: expected ${tc.expectLooksLike}, got ${gotLooksLike}`);
  }

  if (tc.expectIntent !== undefined || tc.expectScheduleType !== undefined || tc.expectDelayMs !== undefined) {
    const intent = parseSchedulerIntent(tc.input, { now: NOW });

    if (tc.expectIntent && intent.intent !== tc.expectIntent) {
      errors.push(`intent: expected "${tc.expectIntent}", got "${intent.intent}"`);
    }

    if (tc.expectScheduleType && intent.scheduleType !== tc.expectScheduleType) {
      errors.push(`scheduleType: expected "${tc.expectScheduleType}", got "${intent.scheduleType}"`);
    }

    if (tc.expectDelayMs !== undefined) {
      if (!intent.runAt) {
        errors.push('delayMs: expected runAt to be set');
      } else {
        const actualDelay = new Date(intent.runAt).getTime() - NOW.getTime();
        const tolerance = tc.expectDelayTolerance ?? 2_000;
        if (Math.abs(actualDelay - tc.expectDelayMs) > tolerance) {
          errors.push(`delayMs: expected ~${tc.expectDelayMs}, got ${actualDelay}`);
        }
      }
    }
  }

  if (errors.length === 0) {
    passed += 1;
    console.log(`PASS [${tc.id}] ${tc.input.slice(0, 60)}`);
  } else {
    failed += 1;
    console.log(`FAIL [${tc.id}] ${tc.input.slice(0, 60)}`);
    for (const err of errors) {
      console.log(`       -> ${err}`);
    }
  }
}

console.log();
console.log('='.repeat(60));
console.log(`TOTAL: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
console.log(`Pass rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
