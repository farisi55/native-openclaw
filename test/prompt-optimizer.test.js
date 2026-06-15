const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.PROMPT_OPTIMIZER_STORE_RUNS = 'false';

const { PromptOptimizer } = require('../dist/prompt-optimizer');
const { cmdPromptOptimize } = require('../dist/cli/commands');
const { SkillRegistry } = require('../dist/skills/registry');

async function withOptimizer(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'openclaw-prompt-opt-'));
  const optimizer = new PromptOptimizer({
    enabled: true,
    mode: 'balanced',
    maxInputChars: 12000,
    maxContextChars: 24000,
    maxToolResultChars: 8000,
    targetModelSmall: true,
    logSummary: false,
    storeRuns: false,
    dataDir: dir,
  });
  try {
    await fn(optimizer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureStdout(fn) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) callback();
    return true;
  });
  try {
    await fn();
    return output.replace(/\x1b\[[0-9;]*m/g, '');
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('self-upgrade token request compiles to SelfUpgradeEngine routing', async () => {
  await withOptimizer(async (optimizer) => {
    const input = 'analisa lalu upgrade, dalam efisiensi penggunaan token, usahakan jangan sampai ada notif : Request too large for model';
    const result = await optimizer.optimize({ userInput: input });

    assert.equal(result.compiled.intent, 'self-upgrade');
    assert.equal(result.compiled.routingHint, 'self-upgrade');
    assert.match(result.compiled.optimizedInput, /SelfUpgradeEngine/);
    assert.match(result.compiled.optimizedInput, /token budget|context compression/i);
    assert.ok(result.compiled.excludedTools.includes('system-execute'));
  });
});

test('capability explanation question stays normal chat with explain-capability routing hint', async () => {
  await withOptimizer(async (optimizer) => {
    const input = 'apa itu fitur self-improvment, self-healing, dan self-upgrade yang ada pada kamu';
    const result = await optimizer.optimize({ userInput: input });

    assert.equal(result.compiled.intent, 'chat');
    assert.equal(result.compiled.routingHint, 'explain-capability');
    assert.ok(!result.compiled.requiredTools.includes('SelfUpgradeEngine'));
    assert.ok(!result.compiled.requiredTools.includes('SelfHealingEngine'));
    assert.match(result.compiled.optimizedInput, /Do not run SelfUpgradeEngine or SelfHealingEngine/i);
  });
});

test('self-upgrade and self-healing explanation questions do not trigger autonomous actions', async () => {
  await withOptimizer(async (optimizer) => {
    const inputs = [
      'apa itu self-upgrade?',
      'jelaskan perbedaan self-improvement, self-healing, self-upgrade',
      'bagaimana cara kerja self-healing?',
      'what is self-upgrade?',
      'explain the self-healing feature',
    ];

    for (const input of inputs) {
      const result = await optimizer.optimize({ userInput: input });
      assert.equal(result.compiled.intent, 'chat', input);
      assert.equal(result.compiled.routingHint, 'explain-capability', input);
      assert.doesNotMatch(result.compiled.optimizedInput, /use SelfUpgradeEngine rather than normal chat/i, input);
    }
  });
});

test('self-upgrade action phrases still route to SelfUpgradeEngine', async () => {
  await withOptimizer(async (optimizer) => {
    const inputs = [
      'jalankan self-upgrade untuk optimasi token',
      'analisa lalu upgrade, cegah Request too large',
      '/upgrade run add csv-reader tool',
    ];

    for (const input of inputs) {
      const result = await optimizer.optimize({ userInput: input });
      assert.equal(result.compiled.intent, 'self-upgrade', input);
      assert.equal(result.compiled.routingHint, 'self-upgrade', input);
    }
  });
});

test('Telegram logging request is app-debug/self-healing, not system-execute', async () => {
  await withOptimizer(async (optimizer) => {
    const result = await optimizer.optimize({ userInput: 'hilangkan notif error : Telegram polling error' });

    assert.equal(result.compiled.intent, 'self-healing');
    assert.equal(result.compiled.routingHint, 'self-healing');
    assert.ok(result.compiled.excludedTools.includes('system-execute'));
    assert.match(result.compiled.optimizedInput, /Telegram polling/i);
  });
});

test('direct email request requires web-fetch then brevo-email verification', async () => {
  await withOptimizer(async (optimizer) => {
    const result = await optimizer.optimize({ userInput: 'kirim berita Arsenal terbaru ke email saya' });

    assert.equal(result.compiled.intent, 'email');
    assert.ok(result.compiled.requiredTools.includes('web-fetch'));
    assert.ok(result.compiled.requiredTools.includes('brevo-email'));
    assert.match(result.compiled.optimizedInput, /brevo-email/i);
    assert.match(result.compiled.optimizedInput, /before claiming/i);
  });
});

test('MCP config update routes to self-configuration and excludes self-healing', async () => {
  await withOptimizer(async (optimizer) => {
    const input = 'Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml milikmu sekarang. Gunakan perintah eksekusi "npx -y @node2flow/google-sheets-mcp".';
    const result = await optimizer.optimize({ userInput: input });

    assert.equal(result.compiled.intent, 'mcp-config-update');
    assert.equal(result.compiled.routingHint, 'self-configuration');
    assert.ok(result.compiled.requiredTools.includes('mcp-agent.configure-server'));
    assert.ok(result.compiled.excludedTools.includes('SelfHealingEngine'));
    assert.ok(result.compiled.excludedTools.includes('SelfUpgradeEngine'));
  });
});

test('MCP config list routes to self-configuration read intent', async () => {
  await withOptimizer(async (optimizer) => {
    const result = await optimizer.optimize({
      userInput: 'list MCP server yang tersedia di mcp_agent.config.yaml',
    });

    assert.equal(result.compiled.intent, 'mcp-config-read');
    assert.equal(result.compiled.routingHint, 'self-configuration');
  });
});

test('natural-language MCP aliases route to self-configuration', async () => {
  await withOptimizer(async (optimizer) => {
    for (const input of [
      'add mcp everything',
      'tambahkan MCP everything untuk smoke test',
      'tambahkan server MCP filesystem',
    ]) {
      const result = await optimizer.optimize({ userInput: input });
      assert.equal(result.compiled.intent, 'mcp-config-update', input);
      assert.equal(result.compiled.routingHint, 'self-configuration', input);
      assert.ok(result.compiled.excludedTools.includes('SelfHealingEngine'), input);
    }
  });
});

test('simple chat stays compact and does not route to tools or autonomous engines', async () => {
  await withOptimizer(async (optimizer) => {
    const input = 'hello kamu siapa';
    const result = await optimizer.optimize({ userInput: input });

    assert.equal(result.compiled.intent, 'chat');
    assert.equal(result.compiled.routingHint, 'simple-chat');
    assert.equal(result.compiled.optimizedInput, input);
    assert.ok(result.compiled.optimizedInput.length <= input.length + 10);
    assert.ok(!result.compiled.requiredTools.includes('SelfUpgradeEngine'));
    assert.ok(!result.compiled.requiredTools.includes('SelfHealingEngine'));
    assert.doesNotMatch(result.compiled.optimizedInput, /Task:|Required action:|Context:/);
  });
});

function makeSkill(id, name, description, tags = []) {
  return {
    id,
    name,
    description,
    filePath: `skills/${id}.md`,
    frontmatter: {
      name,
      description,
      version: '1.0.0',
      tags,
      priority: 1,
      enabled: true,
      raw: {},
    },
    body: 'Skill body.',
  };
}

test('skill relevance avoids simple chat and caps relevant active skills', () => {
  const registry = new SkillRegistry();
  registry.registerAndActivate(makeSkill('auto-arsenal-email', 'Arsenal News Email', 'Fetch Arsenal news and send it by email.', ['arsenal', 'news', 'email']));
  registry.registerAndActivate(makeSkill('telegram-log-fix', 'Telegram Log Troubleshooting', 'Fix Telegram polling log spam.', ['telegram', 'logging']));
  registry.registerAndActivate(makeSkill('gold-email', 'Gold Price Email', 'Send harga emas report by email.', ['harga', 'emas', 'email']));

  assert.equal(registry.relevantActiveSkills('hello kamu siapa', { enabled: true, maxSkills: 3 }).length, 0);

  const selected = registry.relevantActiveSkills('kirim berita Arsenal terbaru ke email saya', {
    enabled: true,
    maxSkills: 2,
  });
  assert.ok(selected.some((skill) => /arsenal|email/i.test(`${skill.name} ${skill.description}`)));
  assert.ok(selected.length <= 2);
});

test('scheduler request preserves relative time and email requirement', async () => {
  await withOptimizer(async (optimizer) => {
    const result = await optimizer.optimize({ userInput: 'buat cronjob 5 menit lagi kirim harga emas ke email saya' });

    assert.equal(result.compiled.intent, 'scheduler');
    assert.equal(result.compiled.routingHint, 'scheduler');
    assert.match(result.compiled.optimizedInput, /5 menit/i);
    assert.match(result.compiled.optimizedInput, /email/i);
  });
});

test('large context compression preserves Request too large signal', async () => {
  await withOptimizer(async (optimizer) => {
    const noisyContext = `${Array(500).fill('old repeated log line').join('\n')}\nERROR Request too large for model while building context`;
    const result = await optimizer.optimize({
      userInput: 'optimalkan penggunaan token agar tidak Request too large',
      context: [noisyContext],
    });

    assert.equal(result.compression.compressionApplied, true);
    assert.ok(result.compiled.optimizedInput.length < result.compression.estimatedOriginalChars);
    assert.match(result.compiled.optimizedInput, /Request too large/i);
  });
});

test('secret redaction applies before optimized prompt output', async () => {
  await withOptimizer(async (optimizer) => {
    const result = await optimizer.optimize({
      userInput: 'fix bug dengan token Bearer abcdefghijklmnopqrstuvwxyz dan xkeysib-abcdefghijklmnopqrstuvwxyz',
    });

    assert.doesNotMatch(result.compiled.optimizedInput, /Bearer abcdef/i);
    assert.doesNotMatch(result.compiled.optimizedInput, /xkeysib-abcdef/i);
    assert.match(result.compiled.optimizedInput, /REDACTED/);
  });
});

test('CLI /prompt-optimize test prints intent and preview', async () => {
  const output = await captureStdout(async () => {
    await cmdPromptOptimize({}, ['test', 'analisa', 'lalu', 'upgrade', 'agar', 'tidak', 'Request', 'too', 'large']);
  });

  assert.match(output, /Prompt Optimization Preview/);
  assert.match(output, /intent: self-upgrade/);
  assert.match(output, /SelfUpgradeEngine/);
});
