const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.SCHEDULER_TIMEZONE = 'Asia/Jakarta';
process.env.SCHEDULER_MISFIRE_POLICY = 'run_once';

const {
  SchedulerEngine,
  SchedulerStore,
  handleCronCommand,
  handleSchedulerText,
  parseSchedulerIntent,
} = require('../dist/scheduler');

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-scheduler-'));
  try {
    await fn(new SchedulerStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('parses active cronjob list request as list intent', () => {
  const intent = parseSchedulerIntent('saya mau lihat ada cronjob apa saja saat ini yang sedang aktif');
  assert.equal(intent.intent, 'list');
  assert.equal(intent.filter, 'active');
});

test('parses lihat semua cronjob as list all intent', () => {
  const intent = parseSchedulerIntent('lihat semua cronjob');
  assert.equal(intent.intent, 'list');
  assert.equal(intent.filter, 'all');
});

test('parses list cronjob aktif as list active intent', () => {
  const intent = parseSchedulerIntent('list cronjob aktif');
  assert.equal(intent.intent, 'list');
  assert.equal(intent.filter, 'active');
});

test('parses cronjob apa saja yang aktif as list active intent', () => {
  const intent = parseSchedulerIntent('cronjob apa saja yang aktif?');
  assert.equal(intent.intent, 'list');
  assert.equal(intent.filter, 'active');
});

test('does not classify management intents as create', () => {
  assert.equal(parseSchedulerIntent('hapus cronjob report harga emas').intent, 'delete');
  assert.equal(parseSchedulerIntent('disable cronjob harga emas').intent, 'disable');
  assert.equal(parseSchedulerIntent('enable cronjob harga emas').intent, 'enable');
  assert.equal(parseSchedulerIntent('update cronjob reminder meeting menjadi jam 16.00').intent, 'update');
});

test('classifies explicit create phrases as create', () => {
  assert.equal(
    parseSchedulerIntent('buatkan cronjob setiap hari jam 17.00 untuk kirim report harga emas').intent,
    'create'
  );
  assert.equal(
    parseSchedulerIntent(
      'kirim email reminder hari ini jam 15.00 untuk meeting client',
      { now: new Date('2026-05-27T01:00:00.000Z'), timezone: 'Asia/Jakarta' }
    ).intent,
    'create'
  );
});

test('parses relative time Arsenal email cronjob', () => {
  const now = new Date('2026-05-27T08:00:00.000Z');
  const intent = parseSchedulerIntent(
    'kirimkan saya berita arsenal 5 menit lagi dari sekarang ke email saya, itu akan jadi cronjob kamu yang baru',
    { now, timezone: 'Asia/Jakarta' }
  );

  assert.equal(intent.intent, 'create');
  assert.equal(intent.scheduleType, 'once');
  assert.equal(intent.name, 'berita-arsenal-email');
  assert.ok(intent.runAt);
  assert.ok(Math.abs(new Date(intent.runAt).getTime() - (now.getTime() + 5 * 60_000)) < 1000);
  assert.match(intent.prompt ?? '', /Arsenal/i);
  assert.match(intent.prompt ?? '', /berita terbaru/i);
  assert.match(intent.prompt ?? '', /web-fetch/i);
  assert.match(intent.prompt ?? '', /email/i);
  assert.match(intent.prompt ?? '', /brevo-email/i);
});

test('parses relative time email reminder cronjob', () => {
  const now = new Date('2026-05-27T08:00:00.000Z');
  const intent = parseSchedulerIntent(
    'kirim email reminder 10 menit lagi untuk meeting client',
    { now, timezone: 'Asia/Jakarta' }
  );

  assert.equal(intent.intent, 'create');
  assert.equal(intent.scheduleType, 'once');
  assert.ok(intent.runAt);
  assert.ok(Math.abs(new Date(intent.runAt).getTime() - (now.getTime() + 10 * 60_000)) < 1000);
});

test('parses daily email report cronjob', () => {
  const intent = parseSchedulerIntent('kirim setiap hari jam 17.00 report harga emas ke email saya');

  assert.equal(intent.intent, 'create');
  assert.equal(intent.scheduleType, 'daily');
  assert.equal(intent.time, '17:00');
  assert.match(intent.prompt ?? '', /harga emas/i);
  assert.match(intent.prompt ?? '', /email/i);
});

test('active cronjob list request returns active-empty response', async () => {
  await withStore(async (store) => {
    const result = await handleSchedulerText(
      'saya mau lihat ada cronjob apa saja saat ini yang sedang aktif',
      { store },
      'cli'
    );

    assert.equal(result.handled, true);
    assert.equal(result.response, 'Belum ada cronjob aktif saat ini.');
  });
});

test('scheduler disabled prevents natural language cronjob creation', async () => {
  const previous = process.env.SCHEDULER_ENABLED;
  process.env.SCHEDULER_ENABLED = 'false';
  try {
    await withStore(async (store) => {
      const result = await handleSchedulerText('buat cronjob 5 menit lagi', { store }, 'cli');
      assert.equal(result.handled, true);
      assert.match(result.response ?? '', /Scheduler sedang nonaktif/);
      assert.equal((await store.listJobs()).length, 0);
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SCHEDULER_ENABLED;
    } else {
      process.env.SCHEDULER_ENABLED = previous;
    }
  }
});

test('creates relative time Arsenal email cronjob from natural language', async () => {
  await withStore(async (store) => {
    const result = await handleSchedulerText(
      'kirimkan saya berita arsenal 5 menit lagi dari sekarang ke email saya, itu akan jadi cronjob kamu yang baru',
      { store },
      'cli'
    );

    assert.equal(result.handled, true);
    assert.match(result.response ?? '', /Cronjob dibuat: berita-arsenal-email/);
    assert.match(result.response ?? '', /5 menit dari sekarang/);
    assert.match(result.response ?? '', /Next run:/);

    const job = await store.getJob('berita-arsenal-email');
    assert.ok(job);
    assert.equal(job.scheduleType, 'once');
    assert.equal(job.enabled, true);
    assert.match(job.prompt, /brevo-email/i);
  });
});

test('creates daily cronjob from Indonesian natural language', async () => {
  await withStore(async (store) => {
    const result = await handleSchedulerText(
      'kirim setiap jam 17.00 report harga emas, buatkan cronjob nya',
      { store },
      'cli'
    );

    assert.equal(result.handled, true);
    assert.match(result.response ?? '', /Cronjob dibuat/);

    const jobs = await store.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, 'report-harga-emas-daily');
    assert.equal(jobs[0].scheduleType, 'daily');
    assert.equal(jobs[0].enabled, true);
    assert.equal(jobs[0].cronExpression, '0 17 * * *');
  });
});

test('parses one-time reminder for today at requested local time', () => {
  const intent = parseSchedulerIntent(
    'kirim email reminder hari ini jam 15.00 untuk mengingatkan saya ada meeting dengan client',
    { now: new Date('2026-05-27T01:00:00.000Z'), timezone: 'Asia/Jakarta' }
  );

  assert.equal(intent.intent, 'create');
  assert.equal(intent.scheduleType, 'once');
  assert.equal(intent.time, '15:00');
  assert.ok(intent.runAt);
  assert.equal(intent.name, 'reminder-meeting-client');
  assert.match(intent.prompt ?? '', /meeting dengan client/i);
});

test('lists stored cronjobs', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'report-harga-emas-daily',
      scheduleType: 'daily',
      cronExpression: '0 17 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim report harga emas.',
      source: 'cli',
    });

    const result = await handleSchedulerText('lihat semua cronjob', { store }, 'cli');
    assert.equal(result.handled, true);
    assert.match(result.response ?? '', /report-harga-emas-daily/);
  });
});

test('updates cronjob schedule time', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'reminder-meeting-client',
      scheduleType: 'daily',
      cronExpression: '0 15 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim reminder meeting.',
      source: 'cli',
    });

    const result = await handleSchedulerText(
      'update cronjob reminder meeting menjadi jam 16.00',
      { store },
      'cli'
    );
    assert.equal(result.handled, true);

    const job = await store.getJob('reminder-meeting-client');
    assert.equal(job.cronExpression, '0 16 * * *');
  });
});

test('disables and enables cronjob', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'report-harga-emas-daily',
      scheduleType: 'daily',
      cronExpression: '0 17 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim report harga emas.',
      source: 'cli',
    });

    await handleSchedulerText('disable cronjob harga emas', { store }, 'cli');
    assert.equal((await store.getJob('harga emas')).enabled, false);

    await handleSchedulerText('enable cronjob harga emas', { store }, 'cli');
    assert.equal((await store.getJob('harga emas')).enabled, true);
  });
});

test('deletes cronjob by natural language target', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'reminder-meeting-client',
      scheduleType: 'daily',
      cronExpression: '0 17 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim reminder.',
      source: 'cli',
    });

    const result = await handleSchedulerText('hapus cronjob reminder meeting', { store }, 'cli');
    assert.equal(result.handled, true);
    assert.equal(await store.getJob('reminder-meeting-client'), null);
  });
});

test('executes due job and records run history', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'due-job',
      scheduleType: 'once',
      runAt: new Date(Date.now() - 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'run now',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      misfirePolicy: 'run_once',
      executor: async () => ({ output: 'done', toolsUsed: ['mock-tool'] }),
    });

    await engine.tick(new Date());
    const runs = await store.listRuns(job.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'success');
    assert.equal(runs[0].output, 'done');
  });
});

test('scheduler awaits executor before recording finished run', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'awaited-job',
      scheduleType: 'once',
      runAt: new Date(Date.now() - 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'run slowly',
      source: 'system',
    });

    let release;
    let started = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const engine = new SchedulerEngine({
      store,
      misfirePolicy: 'run_once',
      executor: async () => {
        started = true;
        await gate;
        return { output: 'done' };
      },
    });

    const tick = engine.tick(new Date());
    await delay(25);
    assert.equal(started, true);
    assert.equal((await store.listRuns()).length, 0);
    release();
    await tick;
    assert.equal((await store.listRuns()).length, 1);
  });
});

test('email-required job fails when brevo-email is not executed', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'email-no-tool',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirimkan ringkasan ke email default user menggunakan tool brevo-email.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({ output: 'claimed sent', toolsUsed: [] }),
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'failed');
    assert.equal(run.emailRequired, true);
    assert.equal(run.emailSent, false);
    assert.match(run.error ?? '', /brevo-email tool was not executed/);

    const updated = await store.getJob(job.id);
    assert.equal(updated.failureCount, 1);
  });
});

test('email-required job fails when brevo-email result is not ok', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'email-brevo-failed',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim email report menggunakan brevo-email.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({
        output: 'Brevo failed',
        toolsUsed: ['brevo-email'],
        toolResults: [{ tool: 'brevo-email', ok: false, error: 'bad recipient' }],
      }),
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'failed');
    assert.equal(run.emailRequired, true);
    assert.equal(run.emailSent, false);
    assert.match(run.error ?? '', /bad recipient|Brevo email failed/);
  });
});

test('email-required job succeeds only when brevo-email returns ok true', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'email-brevo-ok',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim email report menggunakan brevo-email.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({
        output: 'Email berhasil dikirim',
        toolsUsed: ['web-fetch', 'brevo-email'],
        toolResults: [
          { tool: 'web-fetch', ok: true },
          { tool: 'brevo-email', ok: true, parsedResult: { ok: true, messageId: 'abc-123' } },
        ],
      }),
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'success');
    assert.equal(run.emailRequired, true);
    assert.equal(run.emailSent, true);
    assert.equal(run.brevoMessageId, 'abc-123');
    assert.deepEqual(run.toolsUsed, ['web-fetch', 'brevo-email']);
  });
});

test('non-email scheduled job succeeds without brevo-email', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'plain-job',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Buat catatan singkat.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({ output: 'done', toolsUsed: [] }),
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'success');
    assert.equal(run.emailRequired, false);
    assert.equal(run.emailSent, false);
  });
});

test('/cron runs output includes tools and email verification status', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'runs-email-status',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim email report menggunakan brevo-email.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({
        output: 'no email',
        toolsUsed: ['web-fetch'],
        toolResults: [{ tool: 'web-fetch', ok: true }],
      }),
    });
    await engine.runNow(job.name);

    const output = await handleCronCommand(['runs', job.name], { store }, 'cli');
    assert.match(output, /Tools: web-fetch/);
    assert.match(output, /Email: required, not sent/);
    assert.match(output, /Error: Email was required/);
  });
});

test('persists jobs across store instances', async () => {
  await withStore(async (store, dir) => {
    await store.createJob({
      name: 'persistent-job',
      scheduleType: 'daily',
      cronExpression: '0 8 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim rangkuman.',
      source: 'cli',
    });

    const reloaded = new SchedulerStore(dir);
    const job = await reloaded.getJob('persistent-job');
    assert.ok(job);
    assert.equal(job.name, 'persistent-job');
  });
});
