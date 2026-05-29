/**
 * scripts/test-qa-round2.ts
 * QA verification - all Round 1 + Round 2 test cases.
 *
 * Run: npx tsx scripts/test-qa-round2.ts
 */

import { looksLikeSchedulerRequest, parseSchedulerIntent } from '../src/scheduler/scheduler-intent';

interface TC {
  id: string;
  input: string;
  expLooks: boolean;
  expDelay?: number;
  expTolerance?: number;
  note?: string;
}

const NOW = new Date('2026-05-28T03:54:00.000Z');

const tests: TC[] = [
  { id: 'CJ-01', input: 'kirimkan saya harga emas 5 menit lagi ke email', expLooks: true },
  { id: 'CJ-02', input: 'ingatkan saya meeting jam 15:00', expLooks: true },
  { id: 'CJ-03', input: 'jadwalkan kirim berita setiap hari jam 08:00', expLooks: true },
  { id: 'CJ-04', input: 'buat cronjob untuk kirim email jam 09:00', expLooks: true },
  { id: 'CJ-05', input: 'tolong ingatkan saya ambil obat jam 20:00', expLooks: true },
  { id: 'CJ-06', input: 'coba balas pesan ini 2 menit lagi', expLooks: true },
  { id: 'CJ-07', input: 'balas hai juga setelah 30 detik kemudian', expLooks: true, expDelay: 30_000 },
  { id: 'CJ-08', input: 'saya ingin dikirimkan harga emas 5 menit dari sekarang ke email', expLooks: true, expDelay: 300_000 },
  { id: 'CJ-09', input: 'nanti kamu kirim ya laporan harian ke email', expLooks: true },
  { id: 'CJ-10', input: 'bangunkan saya jam 07:00 besok', expLooks: true },
  { id: 'CJ-11', input: 'balas email saya nanti jam 14:00', expLooks: true },
  { id: 'CJ-12', input: 'set alarm meeting besok jam 09:30', expLooks: true },
  { id: 'CJ-13', input: 'dalam 10 menit kirim email ke saya', expLooks: true, expDelay: 600_000 },
  { id: 'CJ-14', input: 'send me gold price in 5 minutes', expLooks: true, expDelay: 300_000 },
  { id: 'CJ-15', input: 'kirim email 5 menit lagi', expLooks: true, expDelay: 300_000 },
  { id: 'CJ-16', input: 'kirim email 5 menit dari sekarang', expLooks: true, expDelay: 300_000 },
  { id: 'CJ-17', input: 'send email in 5 minutes', expLooks: true, expDelay: 300_000 },
  { id: 'CJ-18', input: 'balas pesan setelah 30 detik', expLooks: true, expDelay: 30_000 },
  { id: 'CJ-19', input: 'ingatkan saya setelah 2 menit', expLooks: true, expDelay: 120_000 },
  { id: 'CJ-20', input: 'dalam 10 menit kirim notifikasi', expLooks: true, expDelay: 600_000 },
  { id: 'DR-01', input: 'balas hai juga setelah 30 detik kemudian', expLooks: true, expDelay: 30_000 },
  { id: 'DR-02', input: 'setelah 1 menit reply dengan terima kasih', expLooks: true, expDelay: 60_000 },
  { id: 'DR-03', input: 'balas pesan ini 2 menit kemudian dengan ok siap', expLooks: true, expDelay: 120_000 },
  { id: 'DR-04', input: 'jawab dengan halo 5 detik lagi', expLooks: false, note: 'BUG-15: no action verb for detik unit' },
  { id: 'DR-05', input: 'in 30 seconds reply hi back', expLooks: true, expDelay: 30_000 },
  { id: 'AL-01', input: 'bangunkan saya jam 06:00', expLooks: true },
  { id: 'AL-02', input: 'bangunkan saya besok jam 7', expLooks: true, note: 'BUG-14 fix' },
  { id: 'AL-03', input: 'set alarm jam 08:30 besok', expLooks: true },
  { id: 'AL-04', input: 'wake me up at 5am', expLooks: false },
  { id: 'FU-01', input: 'follow up customer ini besok pagi', expLooks: true },
  { id: 'FU-02', input: 'follow up email ini besok', expLooks: true },
  { id: 'FU-03', input: 'kabari saya nanti soal update project', expLooks: true },
  { id: 'PR-01', input: 'kirimkan berita setiap jam', expLooks: true },
  { id: 'PR-02', input: 'kirim update setiap 30 menit', expLooks: true },
  { id: 'PR-03', input: 'laporan harian jam 08:00 setiap hari', expLooks: true },
  { id: 'PR-04', input: 'ingatkan saya setiap senin', expLooks: true },
  { id: 'PR-05', input: 'remind me every day at 9am', expLooks: true },
  { id: 'FP-04', input: 'film ini berdurasi 2 jam', expLooks: false },
  { id: 'EC-01', input: 'apa harga emas hari ini', expLooks: false },
  { id: 'EC-02', input: 'jelaskan cara membuat kopi', expLooks: false },
  { id: 'TF-01', input: 'kirim email 15 detik dari sekarang', expLooks: true, expDelay: 15_000 },
  { id: 'TF-02', input: 'reminder dalam 45 menit', expLooks: true, expDelay: 2_700_000 },
  { id: 'TF-03', input: 'after 2 hours send report', expLooks: true, expDelay: 7_200_000 },
  { id: 'TF-04', input: 'send in 90 seconds', expLooks: true, expDelay: 90_000 },
  { id: 'SI-08', input: 'nanti kamu kirim ya laporan ke email', expLooks: true },
  { id: 'SI-09', input: 'bangunkan saya jam 07:00', expLooks: true },
  { id: 'SI-10', input: 'balas email nanti jam 14:00', expLooks: true },
  { id: 'SI-11', input: 'tolong ingatkan hari ini jam 15:00', expLooks: true },
  { id: 'SI-12', input: 'set alarm jam 08:00', expLooks: true },
  { id: 'SI-13', input: 'kabari saya nanti jam 10:00', expLooks: true },
  { id: 'SI-14', input: 'follow up email ini besok pagi', expLooks: true },
];

let passed = 0;
let failed = 0;
const failures: string[] = [];

console.log('='.repeat(65));
console.log('QA TEST RUNNER - native-openclaw Round 1 + 2');
console.log('='.repeat(65));
console.log();

for (const tc of tests) {
  const errors: string[] = [];
  const gotLooks = looksLikeSchedulerRequest(tc.input);

  if (gotLooks !== tc.expLooks) {
    errors.push(`looksLike: exp=${tc.expLooks} got=${gotLooks}`);
  }

  if (tc.expDelay !== undefined) {
    const intent = parseSchedulerIntent(tc.input, { now: NOW });
    if (intent.runAt) {
      const actualDelay = new Date(intent.runAt).getTime() - NOW.getTime();
      const tolerance = tc.expTolerance ?? 2_000;
      if (Math.abs(actualDelay - tc.expDelay) > tolerance) {
        errors.push(`delay: exp=${tc.expDelay}ms got=${actualDelay}ms`);
      }
    } else if (tc.expLooks) {
      errors.push('delay: expected runAt to be set, but got undefined');
    }
  }

  if (errors.length === 0) {
    passed += 1;
    console.log(`PASS [${tc.id}] ${tc.input.slice(0, 58)}`);
  } else {
    failed += 1;
    console.log(`FAIL [${tc.id}] ${tc.input.slice(0, 58)}${tc.note ? ` (${tc.note})` : ''}`);
    for (const error of errors) console.log(`       -> ${error}`);
    failures.push(tc.id);
  }
}

console.log();
console.log('='.repeat(65));
console.log(`TOTAL: ${passed + failed} | PASS: ${passed} | FAIL: ${failed}`);
console.log(`Pass rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
if (failures.length > 0) console.log(`Failed IDs: ${failures.join(', ')}`);
console.log('='.repeat(65));

process.exit(failed > 0 ? 1 : 0);
