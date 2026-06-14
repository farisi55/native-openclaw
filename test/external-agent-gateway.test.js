const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { parse } = require('yaml');

const {
  AgentGatewayExecutor,
  AgentGatewayRegistry,
  AgentGatewayService,
  ExternalHttpAgentConnector,
  capabilityForIntent,
  createExternalAgentConnectorsFromEnv,
  externalAgentStatusesFromEnv,
} = require('../dist/agent-gateway');
const { handleAction } = require('../dist/agents/action-handler');

const EXTERNAL_ENV_KEYS = [
  'AGENT_BROWSER_ENABLED',
  'AGENT_RESEARCH_ENABLED',
  'AGENT_SPREADSHEET_ENABLED',
  'AGENT_BROWSER_API_KEY',
];

async function withExternalEnv(values, callback) {
  const saved = Object.fromEntries(
    EXTERNAL_ENV_KEYS.map((key) => [key, process.env[key]])
  );
  for (const key of EXTERNAL_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await callback();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function browserConfig(overrides = {}) {
  return {
    id: 'browser-agent',
    displayName: 'Browser Agent',
    enabled: true,
    baseUrl: 'http://browser-agent.test:3101',
    capabilities: ['browser.automation', 'browser.ui-test'],
    timeoutMs: 100,
    apiKeyEnv: 'AGENT_BROWSER_API_KEY',
    profile: 'browser',
    ...overrides,
  };
}

test('external capability router distinguishes actions from informational chat', () => {
  assert.equal(
    capabilityForIntent('', 'buka https://example.com dan screenshot'),
    'browser.automation'
  );
  assert.equal(
    capabilityForIntent('', 'test UI login di browser'),
    'browser.ui-test'
  );
  assert.equal(
    capabilityForIntent('', 'riset tren AI agentic framework terbaru'),
    'research.web'
  );
  assert.equal(
    capabilityForIntent('', 'bandingkan pasar tools AI coding agent'),
    'research.market'
  );
  assert.equal(
    capabilityForIntent('', 'ambil data dari Google Sheets'),
    'spreadsheet.read'
  );
  assert.equal(
    capabilityForIntent('', 'tulis hasil ini ke spreadsheet'),
    'spreadsheet.write'
  );
  assert.equal(
    capabilityForIntent('', 'buat report spreadsheet mingguan'),
    'spreadsheet.report'
  );
  assert.equal(capabilityForIntent('chat', 'apa itu Playwright?'), null);
  assert.equal(capabilityForIntent('chat', 'apa itu Google Sheets MCP?'), null);
});

test('optional external connectors are disabled by default and register only when enabled', async () => {
  await withExternalEnv({}, async () => {
    assert.deepEqual(createExternalAgentConnectorsFromEnv(), []);
    assert.equal(
      externalAgentStatusesFromEnv().every((status) => !status.enabled),
      true
    );
  });
  await withExternalEnv({ AGENT_BROWSER_ENABLED: 'true' }, async () => {
    assert.deepEqual(
      createExternalAgentConnectorsFromEnv().map((item) => item.id),
      ['browser-agent']
    );
  });
  await withExternalEnv({ AGENT_RESEARCH_ENABLED: 'true' }, async () => {
    assert.deepEqual(
      createExternalAgentConnectorsFromEnv().map((item) => item.id),
      ['research-agent']
    );
  });
  await withExternalEnv({ AGENT_SPREADSHEET_ENABLED: 'true' }, async () => {
    assert.deepEqual(
      createExternalAgentConnectorsFromEnv().map((item) => item.id),
      ['spreadsheet-agent']
    );
  });
});

test('external connector sends normalized payload, auth header, and strips secrets', async () => {
  await withExternalEnv(
    { AGENT_BROWSER_API_KEY: 'agent-secret-key' },
    async () => {
      let request;
      const connector = new ExternalHttpAgentConnector(
        browserConfig(),
        async (url, init) => {
          request = {
            url,
            headers: init.headers,
            payload: JSON.parse(init.body),
          };
          return new Response(
            JSON.stringify({
              ok: true,
              agentId: 'untrusted-id',
              capability: 'untrusted-capability',
              summary: 'Screenshot captured.',
              output: 'Login page inspected.',
              artifacts: [
                '/workspace/artifacts/browser-agent/task-http/screenshot.png',
              ],
              metadata: { durationMs: 12 },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
      );
      const result = await connector.execute({
        id: 'task-http',
        intent: 'browser',
        capability: 'browser.automation',
        userInput: 'buka website dan screenshot',
        context: {
          safe: 'visible',
          apiKey: 'must-not-leak',
          nested: {
            authorization: 'Bearer must-not-leak',
            note: 'keep this',
          },
          protectedFile: {
            path: '.env',
            content: 'DATABASE_URL=postgresql://user:password@localhost/db',
          },
        },
        constraints: { maxRuntimeMs: 1000 },
      });

      assert.equal(result.ok, true);
      assert.equal(result.agentId, 'browser-agent');
      assert.equal(result.capability, 'browser.automation');
      assert.equal(request.url, 'http://browser-agent.test:3101/agent/run');
      assert.equal(request.headers.authorization, 'Bearer agent-secret-key');
      assert.equal(request.payload.context.safe, 'visible');
      assert.equal(request.payload.context.apiKey, undefined);
      assert.equal(request.payload.context.nested.authorization, undefined);
      assert.equal(request.payload.context.nested.note, 'keep this');
      assert.equal(
        request.payload.context.protectedFile.omitted,
        'protected file context'
      );
      assert.doesNotMatch(JSON.stringify(request.payload), /must-not-leak/);
      assert.doesNotMatch(JSON.stringify(request.payload), /DATABASE_URL/);
    }
  );
});

test('external connector handles unavailable service, timeout, and invalid response', async () => {
  const unavailable = new ExternalHttpAgentConnector(
    browserConfig(),
    async () => {
      throw new Error('ECONNREFUSED');
    }
  );
  const unavailableResult = await unavailable.execute({
    id: 'unavailable',
    intent: 'browser',
    capability: 'browser.automation',
    userInput: 'open site',
  });
  assert.equal(unavailableResult.error.code, 'EXTERNAL_AGENT_UNAVAILABLE');

  const timeout = new ExternalHttpAgentConnector(
    browserConfig({ timeoutMs: 10 }),
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        );
      })
  );
  const timeoutResult = await timeout.execute({
    id: 'timeout',
    intent: 'browser',
    capability: 'browser.automation',
    userInput: 'open site',
  });
  assert.equal(timeoutResult.error.code, 'AGENT_TIMEOUT');

  const invalid = new ExternalHttpAgentConnector(
    browserConfig(),
    async () => new Response('not-json', { status: 200 })
  );
  const invalidResult = await invalid.execute({
    id: 'invalid',
    intent: 'browser',
    capability: 'browser.automation',
    userInput: 'open site',
  });
  assert.equal(invalidResult.error.code, 'EXTERNAL_AGENT_INVALID_RESPONSE');
});

test('browser screenshot validation requires a workspace artifact', async () => {
  const connector = new ExternalHttpAgentConnector(
    browserConfig(),
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          summary: 'Screenshot completed.',
          output: 'Done.',
          artifacts: [
            '/workspace/artifacts/browser-agent/task-validated/screenshot.png',
          ],
        }),
        { status: 200 }
      )
  );
  const registry = new AgentGatewayRegistry([connector]);
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'task-validated',
    intent: 'browser',
    capability: 'browser.automation',
    userInput: 'buka website dan screenshot',
  });
  assert.equal(result.ok, true);
  assert.equal(result.validation.ok, true);
});

test('disabled external capability returns actionable profile guidance without executing', async () => {
  await withExternalEnv({}, async () => {
    let executions = 0;
    const service = new AgentGatewayService(
      {
        registry: new AgentGatewayRegistry(),
        execute: async () => {
          executions += 1;
          throw new Error('disabled agent must not execute');
        },
      },
      externalAgentStatusesFromEnv()
    );
    const result = await service.tryExecute({
      intent: 'chat',
      userInput: 'buka https://example.com dan screenshot',
      source: 'web',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EXTERNAL_AGENT_DISABLED');
    assert.match(result.error.message, /--profile browser/);
    assert.equal(executions, 0);
  });
});

test('natural external action is handled before normal chat and returns disabled guidance', async () => {
  await withExternalEnv({}, async () => {
    const service = new AgentGatewayService(
      {
        registry: new AgentGatewayRegistry(),
        execute: async () => {
          throw new Error('disabled agent must not execute');
        },
      },
      externalAgentStatusesFromEnv()
    );
    const result = await handleAction('buka https://example.com dan screenshot', {
      skillRegistry: {},
      sessions: {},
      skillsDir: 'skills',
      activeSessionId: null,
      agentGateway: service,
      onSessionCleared: () => undefined,
    });
    assert.equal(result.handled, true);
    assert.equal(result.actionType, 'capability');
    assert.match(result.response, /AGENT_BROWSER_ENABLED=true/);
  });
});

test('agent health checks are explicit and never run for disabled workers', async () => {
  let healthCalls = 0;
  const connector = new ExternalHttpAgentConnector(
    browserConfig(),
    async () => {
      healthCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  );
  const service = new AgentGatewayService(
    {
      registry: new AgentGatewayRegistry([connector]),
      execute: async () => {
        throw new Error('not used');
      },
    },
    [
      {
        id: 'browser-agent',
        displayName: 'Browser Agent',
        enabled: true,
        registered: false,
        capabilities: ['browser.automation', 'browser.ui-test'],
        riskLevel: 'warning',
        priority: 100,
        profile: 'browser',
      },
      {
        id: 'research-agent',
        displayName: 'Research Agent',
        enabled: false,
        registered: false,
        capabilities: ['research.web', 'research.market'],
        riskLevel: 'safe',
        priority: 100,
        profile: 'research',
      },
    ]
  );

  assert.equal(healthCalls, 0);
  const statuses = await service.healthAgents();
  assert.equal(healthCalls, 1);
  assert.equal(statuses.find((item) => item.id === 'browser-agent').health.ok, true);
  assert.equal(statuses.find((item) => item.id === 'research-agent').health, undefined);
});

test('Docker Compose keeps optional workers behind profiles with no core dependency', async () => {
  const compose = parse(
    await readFile(resolve(__dirname, '..', 'docker-compose.yml'), 'utf8')
  );
  const core = compose.services.openclaw;
  assert.equal(core.depends_on, undefined);
  for (const [name, profile] of [
    ['browser-agent', 'browser'],
    ['research-agent', 'research'],
    ['spreadsheet-agent', 'spreadsheet'],
  ]) {
    const service = compose.services[name];
    assert.ok(service);
    assert.deepEqual(service.profiles, [profile, 'external-agents']);
  }
});
