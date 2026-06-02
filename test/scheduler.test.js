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
  looksLikeSchedulerRequest,
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

function toolRegistry(tools) {
  return {
    getTool(name) {
      const run = tools[name];
      if (!run) return undefined;
      return {
        manifest: { name },
        run,
      };
    },
  };
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

test('parses passive relative-time harga emas email cronjob requests', () => {
  const now = new Date('2026-05-27T08:00:00.000Z');
  const cases = [
    ['saya ingin dikirimkan harga emas 5 menit dari sekarang ke email', 5],
    ['saya ingin dikirimkan harga emas 5 menit dari sekarang, ke email', 5],
    ['dikirimkan harga emas 10 menit dari sekarang ke email', 10],
    ['tolong kirimkan harga emas 5 menit lagi ke email', 5],
    ['kirimkan saya harga emas 5 menit lagi ke email', 5],
    ['send me gold price in 5 minutes to email', 5],
  ];

  for (const [input, minutes] of cases) {
    assert.equal(looksLikeSchedulerRequest(input), true, input);
    const intent = parseSchedulerIntent(input, { now, timezone: 'Asia/Jakarta' });
    assert.equal(intent.intent, 'create', input);
    assert.equal(intent.scheduleType, 'once', input);
    assert.ok(intent.runAt, input);
    assert.ok(
      Math.abs(new Date(intent.runAt).getTime() - (now.getTime() + minutes * 60_000)) < 1000,
      input
    );
    assert.match(intent.prompt ?? '', /harga emas/i, input);
    assert.match(intent.prompt ?? '', /brevo-email/i, input);
  }
});

test('extracts explicit scheduled email metadata', () => {
  const now = new Date('2026-05-27T08:00:00.000Z');
  const intent = parseSchedulerIntent(
    'kirimkan harga emas 2 menit dari sekarang, ke email boss@gmail.com',
    { now, timezone: 'Asia/Jakarta' }
  );

  assert.equal(intent.intent, 'create');
  assert.equal(intent.scheduleType, 'once');
  assert.equal(intent.metadata.recipientEmail, 'boss@gmail.com');
  assert.equal(intent.metadata.emailRequired, true);
  assert.equal(intent.metadata.requiresCurrentData, true);
  assert.match(intent.metadata.searchQuery, /harga emas/i);
  assert.match(intent.prompt ?? '', /boss@gmail.com/);
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
    const input = 'kirimkan saya berita arsenal 5 menit lagi dari sekarang ke email saya, itu akan jadi cronjob kamu yang baru';
    const result = await handleSchedulerText(
      input,
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
    assert.equal(job.metadata.originalUserInput, input);
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

test('/cron list and get format next run in scheduler timezone', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'report-harga-emas-once',
      scheduleType: 'once',
      runAt: '2026-05-28T03:59:53.766Z',
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim report harga emas.',
      source: 'cli',
    });

    const list = await handleCronCommand(['list'], { store }, 'cli');
    assert.match(list, /Next run: 2026-05-28 10:59 Asia\/Jakarta/);
    assert.doesNotMatch(list, /2026-05-28T03:59:53\.766Z/);

    const details = await handleCronCommand(['get', 'report-harga-emas-once'], { store }, 'cli');
    assert.match(details, /Next run: 2026-05-28 10:59 Asia\/Jakarta/);
    assert.doesNotMatch(details, /2026-05-28T03:59:53\.766Z/);
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

test('startup skip policy runs missed once job that never executed', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'startup-once-job',
      scheduleType: 'once',
      runAt: new Date(Date.now() - 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'run after restart',
      source: 'system',
    });

    let executed = false;
    const engine = new SchedulerEngine({
      store,
      misfirePolicy: 'skip',
      tickMs: 60_000,
      executor: async () => {
        executed = true;
        return { output: 'done' };
      },
    });

    await engine.start();
    engine.stop();

    const runs = await store.listRuns(job.id);
    const updated = await store.getJob(job.id);
    assert.equal(executed, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'success');
    assert.equal(updated.runCount, 1);
  });
});

test('startup misfire disabled policy leaves missed jobs untouched', async () => {
  await withStore(async (store) => {
    const runAt = new Date(Date.now() - 1000).toISOString();
    const job = await store.createJob({
      name: 'disabled-misfire-job',
      scheduleType: 'once',
      runAt,
      timezone: 'Asia/Jakarta',
      prompt: 'do not run missed job',
      source: 'system',
    });

    let executed = false;
    const engine = new SchedulerEngine({
      store,
      misfirePolicy: 'disabled',
      tickMs: 60_000,
      executor: async () => {
        executed = true;
        return { output: 'done' };
      },
    });

    await engine.handleStartupMisfires();

    const runs = await store.listRuns(job.id);
    const updated = await store.getJob(job.id);
    assert.equal(executed, false);
    assert.equal(runs.length, 0);
    assert.equal(updated.nextRunAt, runAt);
    assert.equal(updated.runCount, 0);
  });
});

test('tick can start newly due job while another job is running', async () => {
  await withStore(async (store) => {
    await store.createJob({
      name: 'slow-job',
      scheduleType: 'once',
      runAt: new Date(Date.now() - 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'slow',
      source: 'system',
    });

    let release;
    let slowStarted = false;
    let fastRan = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const engine = new SchedulerEngine({
      store,
      maxConcurrentJobs: 2,
      executor: async (job) => {
        if (job.name === 'slow-job') {
          slowStarted = true;
          await gate;
          return { output: 'slow done' };
        }
        if (job.name === 'fast-job') {
          fastRan = true;
          return { output: 'fast done' };
        }
        return { output: 'done' };
      },
    });

    const firstTick = engine.tick(new Date());
    await delay(25);
    assert.equal(slowStarted, true);

    await store.createJob({
      name: 'fast-job',
      scheduleType: 'once',
      runAt: new Date(Date.now() - 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'fast',
      source: 'system',
    });

    await engine.tick(new Date());
    assert.equal(fastRan, true);

    release();
    await firstTick;
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

test('deterministic scheduled email job executes web-fetch then brevo-email', async () => {
  await withStore(async (store) => {
    let webFetchCalled = false;
    let brevoInput;
    let selfImprovementInput;
    const job = await store.createJob({
      name: 'deterministic-email',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Cari harga emas terbaru dan kirim ke email boss@gmail.com.',
      source: 'system',
      metadata: {
        emailRequired: true,
        recipientEmail: 'boss@gmail.com',
        topic: 'harga emas',
        requiresCurrentData: true,
        searchQuery: 'harga emas hari ini',
        originalUserInput: 'kirimkan harga emas 2 menit dari sekarang, ke email boss@gmail.com',
      },
    });

    const engine = new SchedulerEngine({
      store,
      toolRegistry: toolRegistry({
        'web-fetch': async (input) => {
          webFetchCalled = true;
          assert.equal(input.query, 'harga emas hari ini');
          return 'Harga emas hari ini Rp1.500.000/gram.';
        },
        'brevo-email': async (input) => {
          brevoInput = input;
          return JSON.stringify({
            ok: true,
            provider: 'brevo',
            status: 201,
            messageId: 'abc',
            recipientEmail: input.recipientEmail,
          });
        },
      }),
      emailContentGenerator: async (input) => {
        assert.equal(input.recipientEmail, 'boss@gmail.com');
        assert.match(input.webFetchResult ?? '', /Rp1\.500\.000/);
        return {
          subject: 'Harga Emas Hari Ini',
          htmlContent: '<p>Harga emas Rp1.500.000/gram.</p>',
        };
      },
      selfImprovement: (input) => {
        selfImprovementInput = input;
      },
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'success');
    assert.equal(run.emailSent, true);
    assert.equal(run.recipientEmail, 'boss@gmail.com');
    assert.equal(run.brevoMessageId, 'abc');
    assert.equal(webFetchCalled, true);
    assert.equal(brevoInput.recipientEmail, 'boss@gmail.com');
    assert.deepEqual(run.toolsUsed, ['web-fetch', 'brevo-email']);
    assert.equal(selfImprovementInput.source, 'scheduler');
    assert.equal(selfImprovementInput.wasSchedulerAction, true);
    assert.equal(selfImprovementInput.success, true);
    assert.equal(selfImprovementInput.scheduledJobId, job.id);
    assert.equal(selfImprovementInput.scheduledJobName, job.name);
    assert.equal(selfImprovementInput.emailRequired, true);
    assert.equal(selfImprovementInput.emailSent, true);
    assert.deepEqual(selfImprovementInput.toolsUsed, ['web-fetch', 'brevo-email']);
    assert.equal(selfImprovementInput.userInput, 'kirimkan harga emas 2 menit dari sekarang, ke email boss@gmail.com');
  });
});

test('deterministic scheduled email job fails when brevo-email tool is missing', async () => {
  await withStore(async (store) => {
    let selfImprovementInput;
    const job = await store.createJob({
      name: 'missing-brevo',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim email report menggunakan brevo-email.',
      source: 'system',
      metadata: { emailRequired: true },
    });

    const engine = new SchedulerEngine({
      store,
      toolRegistry: toolRegistry({
        'web-fetch': async () => 'data',
      }),
      selfImprovement: (input) => {
        selfImprovementInput = input;
      },
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'failed');
    assert.equal(run.emailSent, false);
    assert.match(run.error ?? '', /brevo-email tool is not registered/);
    const updated = await store.getJob(job.id);
    assert.equal(updated.failureCount, 1);
    assert.equal(selfImprovementInput.source, 'scheduler');
    assert.equal(selfImprovementInput.success, false);
    assert.equal(selfImprovementInput.emailRequired, true);
    assert.equal(selfImprovementInput.emailSent, false);
    assert.match(selfImprovementInput.error, /brevo-email tool is not registered/);
  });
});

test('self-improvement callback error does not fail scheduled job', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'self-improve-error',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Buat catatan singkat.',
      source: 'system',
    });

    const engine = new SchedulerEngine({
      store,
      executor: async () => ({ output: 'done', toolsUsed: [] }),
      selfImprovement: () => {
        throw new Error('extractor offline');
      },
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'success');
    assert.equal(run.output, 'done');
    const updated = await store.getJob(job.id);
    assert.equal(updated.failureCount, 0);
  });
});

test('deterministic scheduled email job fails when brevo-email returns ok false', async () => {
  await withStore(async (store) => {
    const job = await store.createJob({
      name: 'brevo-ok-false',
      scheduleType: 'once',
      runAt: new Date().toISOString(),
      timezone: 'Asia/Jakarta',
      prompt: 'Kirim email report menggunakan brevo-email.',
      source: 'system',
      metadata: { emailRequired: true, recipientEmail: 'boss@gmail.com' },
    });

    const engine = new SchedulerEngine({
      store,
      toolRegistry: toolRegistry({
        'brevo-email': async () => JSON.stringify({
          ok: false,
          provider: 'brevo',
          status: 400,
          error: 'bad recipient',
        }),
      }),
      emailContentGenerator: async () => ({
        subject: 'Report',
        htmlContent: '<p>Report</p>',
      }),
    });

    const run = await engine.runNow(job.name);
    assert.equal(run.status, 'failed');
    assert.equal(run.emailSent, false);
    assert.match(run.error ?? '', /bad recipient/);
    const updated = await store.getJob(job.id);
    assert.equal(updated.failureCount, 1);
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

test('rejects invalid cron expressions on create and update', async () => {
  await withStore(async (store) => {
    const invalidExpressions = [
      '* * * * * * * *',
      '99 99 99 99 99',
      'invalid cron',
      '',
    ];

    for (const cronExpression of invalidExpressions) {
      await assert.rejects(
        () => store.createJob({
          name: `invalid-cron-${invalidExpressions.indexOf(cronExpression)}`,
          scheduleType: 'cron',
          cronExpression,
          timezone: 'Asia/Jakarta',
          prompt: 'should not persist',
          source: 'system',
        }),
        /invalid cron expression/i
      );
    }
    assert.equal((await store.listJobs()).length, 0);

    const valid = await store.createJob({
      name: 'valid-cron',
      scheduleType: 'cron',
      cronExpression: '0 8 * * *',
      timezone: 'Asia/Jakarta',
      prompt: 'valid job',
      source: 'system',
    });

    await assert.rejects(
      () => store.updateJob(valid.id, { cronExpression: 'invalid cron' }),
      /invalid cron expression/i
    );
    const unchanged = await store.getJob(valid.id);
    assert.equal(unchanged.cronExpression, '0 8 * * *');
  });
});
