const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { handleAction } = require('../dist/agents/action-handler');
const {
  capabilityForIntent,
  externalAgentEnablementMessage,
} = require('../dist/agent-gateway');
const { McpConfigService } = require('../dist/mcp-agent');
const { ProviderRouter } = require('../dist/router');
const { ReportWriter } = require('../dist/self-healing');
const { createMessage } = require('../dist/types/message');
const { ProviderError } = require('../dist/types/provider');

async function withTempDir(prefix, callback) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function actionContext(agentGateway) {
  return {
    skillRegistry: {},
    sessions: {},
    skillsDir: 'skills',
    activeSessionId: null,
    agentGateway,
    onSessionCleared() {},
  };
}

test('normal informational chat skips AgentGateway execution', async () => {
  for (const input of [
    'halo',
    'apa itu MCP?',
    'jelaskan apa itu agentic orchestrator',
  ]) {
    let gatewayCalls = 0;
    const result = await handleAction(input, actionContext({
      tryExecute: async () => {
        gatewayCalls += 1;
        throw new Error('normal chat must not enter AgentGateway');
      },
    }));

    assert.equal(result.handled, false);
    assert.equal(gatewayCalls, 0);
  }
});

test('autonomous repair and MCP configuration resolve to dedicated capabilities', () => {
  assert.equal(
    capabilityForIntent('self-healing', 'fix error notif Telegram'),
    'coding.patch'
  );
  assert.equal(
    capabilityForIntent(
      'self-healing',
      'cek kenapa Telegram polling error masih muncul'
    ),
    'coding.patch'
  );
  assert.equal(
    capabilityForIntent(
      'mcp-config-update',
      'tambahkan server MCP google-sheets'
    ),
    'mcp.config'
  );
});

test('ProviderRouter returns sanitized fallback attempt metadata', async () => {
  await withTempDir('native-openclaw-phase35-router-', async (dataDir) => {
    const previousOrder = process.env.PROVIDER_ORDER;
    process.env.PROVIDER_ORDER = 'primary,fallback';
    try {
      const primary = {
        id: 'primary',
        displayName: 'Primary',
        async listModels() {
          return [{ id: 'primary-model' }];
        },
        async chat() {
          throw new ProviderError(
            'primary',
            'RATE_LIMITED',
            'Bearer secret-provider-token was rate limited'
          );
        },
      };
      const fallback = {
        id: 'fallback',
        displayName: 'Fallback',
        async listModels() {
          return [{ id: 'fallback-model' }];
        },
        async chat() {
          return {
            message: createMessage({ role: 'assistant', content: 'fallback ok' }),
            model: 'fallback-model',
            latencyMs: 1,
          };
        },
      };
      const router = new ProviderRouter(
        new Map([
          ['primary', primary],
          ['fallback', fallback],
        ]),
        {
          enabled: true,
          autoFallback: true,
          autoSwitch: false,
          maxAttempts: 2,
          dataDir,
        }
      );
      await router.init();

      const result = await router.chat(primary, 'primary-model', {
        model: 'primary-model',
        messages: [],
      });

      assert.equal(result.providerId, 'fallback');
      assert.equal(result.usedFallback, true);
      assert.deepEqual(result.fallbackChain, ['primary', 'fallback']);
      assert.equal(result.failedProviders.length, 1);
      assert.equal(result.failedProviders[0].errorCode, 'RATE_LIMITED');
      assert.match(result.failedProviders[0].errorMessage, /\[REDACTED\]/);
      assert.doesNotMatch(
        JSON.stringify(result.failedProviders),
        /secret-provider-token/
      );
    } finally {
      if (previousOrder === undefined) delete process.env.PROVIDER_ORDER;
      else process.env.PROVIDER_ORDER = previousOrder;
    }
  });
});

test('MCP source-of-truth service rejects paths outside project root', async () => {
  await withTempDir('native-openclaw-phase35-mcp-', async (root) => {
    const service = new McpConfigService(root, './mcp_agent.config.yaml');
    await assert.rejects(
      service.write(
        { mcpServers: {} },
        resolve(root, '..', 'outside.yaml')
      ),
      /inside the project root/i
    );
    await assert.rejects(
      Promise.resolve().then(() => service.resolveConfigPath('../../.env')),
      /inside the project root|protected file/i
    );
  });
});

test('disabled external agent guidance is explicit and does not claim execution', () => {
  const browser = externalAgentEnablementMessage('browser.automation');
  const research = externalAgentEnablementMessage('research.web');
  const spreadsheet = externalAgentEnablementMessage('spreadsheet.read');

  assert.match(browser, /--profile browser/);
  assert.match(research, /--profile research/);
  assert.match(spreadsheet, /--profile spreadsheet/);
  for (const message of [browser, research, spreadsheet]) {
    assert.doesNotMatch(message, /\b(?:completed|berhasil dijalankan|screenshot captured)\b/i);
  }
});

test('final autonomous report includes gateway, provider, QA, and rollback fields', async () => {
  await withTempDir('native-openclaw-phase35-report-', async (runsDir) => {
    const writer = new ReportWriter(runsDir, true);
    const run = {
      id: 'heal-phase35-report',
      type: 'self-healing',
      status: 'rolled_back',
      userInput: 'fix Telegram polling error',
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1000).toISOString(),
      maxLoops: 1,
      currentLoop: 1,
      workdir: process.cwd(),
      loops: [{
        loop: 1,
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1000).toISOString(),
        status: 'failed',
        changedFiles: ['src/integrations/telegram.ts'],
        commandsRun: [{
          command: 'npm run build',
          exitCode: 2,
          stdout: '',
          stderr: 'Bearer report-secret-token compile failed',
          durationMs: 100,
          timedOut: false,
        }],
        qaReport: {
          passed: false,
          summary: 'Build failed',
          failedCommand: 'npm run build',
          missingPackages: [],
          errors: ['compile failed'],
          nextAction: 'retry_fix',
          rawLogExcerpt: 'Bearer report-secret-token compile failed',
        },
      }],
      finalSummary: 'Changes failed QA and were restored.',
      agentUsed: 'internal-coding',
      agentFallbackPath: ['opencode', 'internal-coding'],
      agentFailedAgents: [{
        agentId: 'opencode',
        code: 'NO_DETECTABLE_CHANGES',
        message: 'No changes',
      }],
      agentValidation: {
        ok: true,
        warnings: [],
        errors: [],
      },
      providerUsed: 'fallback-provider',
      providerModel: 'fallback-model',
      providerFallbackUsed: true,
      providerFallbackPath: ['primary-provider', 'fallback-provider'],
      providerFailures: [{
        providerId: 'primary-provider',
        model: 'primary-model',
        errorCode: 'RATE_LIMITED',
        errorMessage: 'Bearer provider-secret-token failed',
      }],
    };

    await writer.writeStart(run, {});
    await writer.writeLoop(run.id, run.loops[0]);
    await writer.writeFinal(run);
    const report = await readFile(
      join(runsDir, run.id, 'final-report.md'),
      'utf8'
    );

    assert.match(report, /Agent used: internal-coding/);
    assert.match(report, /opencode -> internal-coding/);
    assert.match(report, /NO_DETECTABLE_CHANGES/);
    assert.match(report, /Agent validation: passed/);
    assert.match(report, /primary-provider -> fallback-provider/);
    assert.match(report, /Command `npm run build`: failed/);
    assert.match(report, /STDERR preview/);
    assert.match(report, /Rollback status: completed/);
    assert.match(report, /\[REDACTED\]/);
    assert.doesNotMatch(report, /report-secret-token|provider-secret-token/);
  });
});

test('Docker Compose default and profile service sets remain isolated', async () => {
  const compose = parse(
    await readFile(resolve(__dirname, '..', 'docker-compose.yml'), 'utf8')
  );
  assert.equal(compose.services.openclaw.depends_on, undefined);
  assert.deepEqual(compose.services['browser-agent'].profiles, [
    'browser',
    'external-agents',
  ]);
  assert.deepEqual(compose.services['research-agent'].profiles, [
    'research',
    'external-agents',
  ]);
  assert.deepEqual(compose.services['spreadsheet-agent'].profiles, [
    'spreadsheet',
    'external-agents',
  ]);
});
