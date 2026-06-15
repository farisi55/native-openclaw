const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  AgentGatewayExecutor,
  AgentGatewayRegistry,
  AgentGatewayService,
  InternalCodingConnector,
  McpAgentConnector,
  OpenCodeConnector,
  capabilityForIntent,
} = require('../dist/agent-gateway');
const { McpManager } = require('../dist/mcp');
const { McpAgentService } = require('../dist/mcp-agent');
const { handleAction } = require('../dist/agents/action-handler');

function connector(id, options = {}) {
  return {
    id,
    displayName: id,
    capabilities: options.capabilities ?? ['coding.patch'],
    riskLevel: 'warning',
    priority: options.priority ?? 50,
    isEnabled: () => options.enabled ?? true,
    canHandle: () => options.canHandle ?? true,
    execute: options.execute ?? (async (task) => ({
      ok: true,
      agentId: id,
      capability: task.capability,
      summary: `${id} ok`,
    })),
  };
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'native-openclaw-agent-gateway-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('capability router maps autonomous and MCP intents', () => {
  assert.equal(capabilityForIntent('self-healing', 'fix error'), 'coding.patch');
  assert.equal(capabilityForIntent('self-upgrade', 'add feature'), 'coding.patch');
  assert.equal(capabilityForIntent('', 'fix bug in Telegram module'), 'coding.patch');
  assert.equal(capabilityForIntent('', 'review this code module'), 'coding.review');
  assert.equal(capabilityForIntent('', 'refactor this module'), 'coding.refactor');
  assert.equal(capabilityForIntent('', 'test this code build'), 'coding.test');
  assert.equal(capabilityForIntent('mcp-config-update', 'add MCP server'), 'mcp.config');
  assert.equal(capabilityForIntent('mcp-config-read', 'list MCP servers'), 'mcp.server.list');
  assert.equal(capabilityForIntent('', 'start MCP server google-sheets'), 'mcp.server.start');
  assert.equal(capabilityForIntent('', 'stop MCP server google-sheets'), 'mcp.server.stop');
  assert.equal(capabilityForIntent('chat', 'apa itu MCP?'), null);
  assert.equal(capabilityForIntent('chat', 'hello, siapa kamu?'), null);
});

test('registry returns only enabled connectors for the capability', () => {
  const registry = new AgentGatewayRegistry();
  registry.register(connector('enabled'));
  registry.register(connector('disabled', { enabled: false }));
  const task = {
    id: 'registry-test',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
  };
  assert.deepEqual(registry.enabledFor('coding.patch', task).map((item) => item.id), ['enabled']);
});

test('registry orders enabled connectors by priority', () => {
  const registry = new AgentGatewayRegistry([
    connector('later', { priority: 20 }),
    connector('first', { priority: 10 }),
    connector('disabled', { priority: 1, enabled: false }),
  ]);
  const task = {
    id: 'registry-priority',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
  };
  assert.deepEqual(
    registry.enabledFor('coding.patch', task).map((item) => item.id),
    ['first', 'later']
  );
});

test('default coding connectors route review and test by priority with internal fallback', async () => {
  const saved = {
    AGENT_OPENCODE_ENABLED: process.env.AGENT_OPENCODE_ENABLED,
    AGENT_INTERNAL_CODING_ENABLED: process.env.AGENT_INTERNAL_CODING_ENABLED,
  };
  process.env.AGENT_OPENCODE_ENABLED = 'true';
  process.env.AGENT_INTERNAL_CODING_ENABLED = 'true';

  const fakeProvider = {
    id: 'fake-provider',
    displayName: 'Fake Provider',
    async chat() {
      return {
        message: { content: 'Internal review found one actionable issue.' },
        model: 'fake-model',
        latencyMs: 1,
      };
    },
    async listModels() {
      return [];
    },
  };
  const failedOpenCodeRunner = async (input) => ({
    ok: false,
    mode: input.mode,
    task: input.task,
    stdout: '',
    stderr: 'OpenCode unavailable',
    exitCode: 1,
    durationMs: 1,
    timedOut: false,
    truncated: false,
    summary: 'OpenCode unavailable',
    error: 'OpenCode unavailable',
    errorType: 'unknown',
  });

  try {
    const registry = new AgentGatewayRegistry([
      new InternalCodingConnector(fakeProvider),
      new OpenCodeConnector({}, failedOpenCodeRunner),
    ]);
    const reviewTask = {
      id: 'review-fallback',
      intent: 'code-review',
      capability: 'coding.review',
      userInput: 'review this module',
    };
    assert.deepEqual(
      registry.enabledFor('coding.review', reviewTask).map((item) => item.id),
      ['opencode', 'internal-coding']
    );
    assert.deepEqual(
      registry.enabledFor('coding.test', {
        ...reviewTask,
        id: 'test-priority',
        capability: 'coding.test',
      }).map((item) => item.id),
      ['opencode', 'internal-coding']
    );

    const result = await new AgentGatewayExecutor({ registry }).execute(reviewTask);
    assert.equal(result.ok, true);
    assert.equal(result.agentId, 'internal-coding');
    assert.equal(result.output, 'Internal review found one actionable issue.');
    assert.deepEqual(result.fallbackChain, ['opencode', 'internal-coding']);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('gateway falls back from OpenCode no-change to internal coding', async () => {
  const registry = new AgentGatewayRegistry();
  registry.register(connector('opencode', {
    execute: async (task) => ({
      ok: false,
      agentId: 'opencode',
      capability: task.capability,
      summary: 'no changes',
      error: {
        code: 'NO_DETECTABLE_CHANGES',
        message: 'OpenCode completed but did not produce detectable file changes.',
      },
    }),
  }));
  registry.register(connector('internal-coding', {
    execute: async (task) => ({
      ok: true,
      agentId: 'internal-coding',
      capability: task.capability,
      summary: 'patched',
      changedFiles: ['src/fixed.ts'],
    }),
  }));
  const gateway = new AgentGatewayExecutor({ registry });
  const result = await gateway.execute({
    id: 'fallback-test',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
    constraints: { allowedPaths: ['src/fixed.ts'] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'internal-coding');
  assert.deepEqual(result.metadata.fallbackPath, ['opencode', 'internal-coding']);
  assert.equal(result.metadata.fallbackUsed, true);
});

test('disabled OpenCode skips directly to internal coding', async () => {
  let openCodeCalls = 0;
  const registry = new AgentGatewayRegistry();
  registry.register(connector('opencode', {
    enabled: false,
    execute: async () => {
      openCodeCalls += 1;
      throw new Error('disabled connector must not execute');
    },
  }));
  registry.register(connector('internal-coding', {
    execute: async (task) => ({
      ok: true,
      agentId: 'internal-coding',
      capability: task.capability,
      summary: 'patched',
      changedFiles: ['src/fixed.ts'],
    }),
  }));
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'disabled-opencode',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
    constraints: { allowedPaths: ['src/fixed.ts'] },
  });

  assert.equal(result.agentId, 'internal-coding');
  assert.equal(openCodeCalls, 0);
  assert.deepEqual(result.metadata.fallbackPath, ['internal-coding']);
});

test('policy restores forbidden dependency changes before fallback', async () => {
  const restored = [];
  const registry = new AgentGatewayRegistry();
  registry.register(connector('opencode', {
    execute: async (task) => ({
      ok: true,
      agentId: 'opencode',
      capability: task.capability,
      summary: 'changed package manifest',
      changedFiles: ['package.json'],
    }),
  }));
  registry.register(connector('internal-coding', {
    execute: async (task) => ({
      ok: true,
      agentId: 'internal-coding',
      capability: task.capability,
      summary: 'safe patch',
      changedFiles: ['src/safe.ts'],
    }),
  }));
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'policy-rollback',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix source only',
    context: {
      rollbackFiles: async (files) => restored.push(...files),
    },
    constraints: {
      allowedPaths: ['src/safe.ts', 'package.json'],
      allowPackageJsonChanges: false,
    },
  });

  assert.deepEqual(restored, ['package.json']);
  assert.equal(result.agentId, 'internal-coding');
  assert.match(result.metadata.warnings[0], /dependency manifest/);
});

test('OpenCode connector receives complete patch context and rejects no-change success', async () => {
  const saved = {
    OPENCODE_AGENT_ENABLED: process.env.OPENCODE_AGENT_ENABLED,
    OPENCODE_AGENT_USE_FOR_SELF_HEALING: process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING,
    AGENT_OPENCODE_ENABLED: process.env.AGENT_OPENCODE_ENABLED,
  };
  process.env.OPENCODE_AGENT_ENABLED = 'true';
  process.env.OPENCODE_AGENT_USE_FOR_SELF_HEALING = 'true';
  process.env.AGENT_OPENCODE_ENABLED = 'true';
  let received;
  const fakeCodingAgent = {
    async applyBugFix(input) {
      received = input;
      return [];
    },
  };

  try {
    const connectorInstance = new OpenCodeConnector(fakeCodingAgent);
    const task = {
      id: 'opencode-context',
      intent: 'self-healing',
      capability: 'coding.patch',
      userInput: 'fix Telegram polling log spam',
      context: {
        mode: 'self-healing',
        analysis: {
          summary: 'polling logs repeat',
          likelyCause: 'conflict logging ignores suppression',
          affectedFiles: ['src/integrations/telegram.ts'],
          fixStrategy: 'respect environment flags',
          confidence: 0.9,
        },
        patchPlan: {
          files: [{
            path: 'src/integrations/telegram.ts',
            action: 'update',
            reason: 'suppress repeated logs',
          }],
          testStrategy: 'npm test',
          riskLevel: 'low',
        },
        patchApplier: {},
        previousQa: {
          passed: false,
          summary: 'test failed',
          missingPackages: [],
          errors: ['polling log assertion failed'],
          nextAction: 'retry_fix',
          rawLogExcerpt: 'polling log assertion failed',
        },
        openCodeState: {},
        executionState: {},
      },
    };
    assert.equal(connectorInstance.canHandle(task), true);
    const result = await connectorInstance.execute(task);

    assert.equal(received.userInput, task.userInput);
    assert.equal(received.executionMode, 'opencode-only');
    assert.equal(received.analysis.likelyCause, 'conflict logging ignores suppression');
    assert.equal(received.patchPlan.files[0].path, 'src/integrations/telegram.ts');
    assert.equal(received.previousQa.summary, 'test failed');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'NO_DETECTABLE_CHANGES');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('MCP connector writes and lists the shared YAML configuration', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    const service = new McpAgentService({
      enabled: true,
      allowConfigWrite: true,
      projectRoot: root,
      configPath,
      validateNpmPackage: false,
    });
    const manager = new McpManager({ configPath });
    await manager.init();
    const registry = new AgentGatewayRegistry();
    registry.register(new McpAgentConnector(service, manager));
    const gateway = new AgentGatewayExecutor({ registry });

    const added = await gateway.execute({
      id: 'mcp-add',
      intent: 'mcp-config-update',
      capability: 'mcp.config',
      userInput: 'Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml. Gunakan perintah eksekusi "npx -y @node2flow/google-sheets-mcp".',
      cwd: root,
    });
    const listed = await gateway.execute({
      id: 'mcp-list',
      intent: 'mcp-config-read',
      capability: 'mcp.server.list',
      userInput: 'list MCP server yang tersedia di mcp_agent.config.yaml',
      cwd: root,
    });

    assert.equal(added.ok, true);
    assert.equal(listed.ok, true);
    assert.match(listed.output, /google-sheets/);
    assert.match(await readFile(configPath, 'utf-8'), /@node2flow\/google-sheets-mcp/);
    assert.equal((await manager.listServers())[0].name, 'google-sheets');
  });
});

test('MCP configuration is handled as self-configuration and never enters self-healing', async () => {
  let gatewayCalls = 0;
  let selfHealingCalls = 0;
  const result = await handleAction(
    'tambahkan server MCP google-sheets',
    {
      skillRegistry: {},
      sessions: {},
      skillsDir: 'skills',
      activeSessionId: null,
      agentGateway: {
        tryExecute: async (request) => {
          gatewayCalls += 1;
          assert.equal(request.capability, 'mcp.config');
          return {
            ok: true,
            agentId: 'mcp-agent',
            capability: request.capability,
            summary: 'MCP server configured',
          };
        },
      },
      selfHealing: {
        healing: {
          run: async () => {
            selfHealingCalls += 1;
            throw new Error('MCP configuration must not enter self-healing');
          },
        },
        upgrade: {
          run: async () => {
            selfHealingCalls += 1;
            throw new Error('MCP configuration must not enter self-upgrade');
          },
        },
      },
      onSessionCleared: () => undefined,
    },
    {
      originalInput: 'tambahkan server MCP google-sheets',
      optimizedInput: 'tambahkan server MCP google-sheets',
      intent: 'mcp-config-update',
      routingHint: 'self-configuration',
      tokenBudget: {
        estimatedInputChars: 36,
        maxInputChars: 12_000,
        compressionApplied: false,
      },
      requiredTools: [],
      excludedTools: [],
      metadata: {},
    }
  );

  assert.equal(result.handled, true);
  assert.equal(result.actionType, 'self_configuration');
  assert.equal(result.response, 'MCP server configured');
  assert.equal(gatewayCalls, 1);
  assert.equal(selfHealingCalls, 0);
});

test('connector timeout aborts the connector and falls back safely', async () => {
  let aborted = false;
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      priority: 10,
      execute: async (task, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          resolve({
            ok: false,
            agentId: 'opencode',
            capability: task.capability,
            summary: 'aborted',
            error: { code: 'AGENT_ABORTED', message: 'aborted' },
          });
        }, { once: true });
      }),
    }),
    connector('internal-coding', {
      priority: 20,
      execute: async (task) => ({
        ok: true,
        agentId: 'internal-coding',
        capability: task.capability,
        summary: 'fallback patched',
        changedFiles: ['src/timeout-fixed.ts'],
      }),
    }),
  ]);
  const result = await new AgentGatewayExecutor({
    registry,
    config: { defaultTimeoutMs: 10, maxFallbacks: 1 },
  }).execute({
    id: 'timeout-fallback',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix timeout',
    constraints: {
      maxRuntimeMs: 10,
      allowedPaths: ['src/timeout-fixed.ts'],
    },
  });

  assert.equal(aborted, true);
  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'internal-coding');
  assert.equal(result.fallbackUsed, true);
  assert.deepEqual(result.fallbackChain, ['opencode', 'internal-coding']);
  assert.equal(result.failedAgents[0].code, 'AGENT_TIMEOUT');
});

test('timeout returns normalized AGENT_TIMEOUT without crashing when no fallback exists', async () => {
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async () => new Promise(() => undefined),
    }),
  ]);
  const result = await new AgentGatewayExecutor({
    registry,
    config: { defaultTimeoutMs: 5, maxFallbacks: 0 },
  }).execute({
    id: 'timeout-final',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix timeout',
    constraints: { maxRuntimeMs: 5 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'AGENT_TIMEOUT');
  assert.deepEqual(result.fallbackChain, ['opencode']);
});

test('coding.patch success without changed files is invalid and triggers fallback', async () => {
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async (task) => ({
        ok: true,
        agentId: 'opencode',
        capability: task.capability,
        summary: 'claimed success without patch',
      }),
    }),
    connector('internal-coding', {
      execute: async (task) => ({
        ok: true,
        agentId: 'internal-coding',
        capability: task.capability,
        summary: 'real patch',
        changedFiles: ['src/validated.ts'],
      }),
    }),
  ]);
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'validation-fallback',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
    constraints: { allowedPaths: ['src/validated.ts'] },
  });

  assert.equal(result.ok, true);
  assert.equal(result.agentId, 'internal-coding');
  assert.equal(result.failedAgents[0].code, 'NO_DETECTABLE_CHANGES');
  assert.equal(result.validation.ok, true);
});

test('failed final connector includes normalized fallback metadata', async () => {
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async (task) => ({
        ok: false,
        agentId: 'opencode',
        capability: task.capability,
        summary: 'unavailable',
        error: { code: 'OPENCODE_UNAVAILABLE', message: 'unavailable' },
      }),
    }),
    connector('internal-coding', {
      execute: async (task) => ({
        ok: false,
        agentId: 'internal-coding',
        capability: task.capability,
        summary: 'provider failed',
        error: { code: 'PROVIDER_FAILED', message: 'provider failed' },
      }),
    }),
  ]);
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'all-failed',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROVIDER_FAILED');
  assert.equal(result.selectedAgent, 'internal-coding');
  assert.deepEqual(result.fallbackChain, ['opencode', 'internal-coding']);
  assert.deepEqual(
    result.failedAgents.map((item) => item.agentId),
    ['opencode', 'internal-coding']
  );
});

test('maxFallbacks prevents connectors beyond the configured limit', async () => {
  let fallbackCalls = 0;
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async (task) => ({
        ok: false,
        agentId: 'opencode',
        capability: task.capability,
        summary: 'failed',
        error: { code: 'FAILED', message: 'failed' },
      }),
    }),
    connector('internal-coding', {
      execute: async (task) => {
        fallbackCalls += 1;
        return {
          ok: true,
          agentId: 'internal-coding',
          capability: task.capability,
          summary: 'patched',
          changedFiles: ['src/should-not-run.ts'],
        };
      },
    }),
  ]);
  const result = await new AgentGatewayExecutor({
    registry,
    config: { maxFallbacks: 0 },
  }).execute({
    id: 'no-fallback',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix bug',
  });

  assert.equal(result.ok, false);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(result.fallbackChain, ['opencode']);
});

test('forbidden file changes are rolled back and rejected', async () => {
  const restored = [];
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async (task) => ({
        ok: true,
        agentId: 'opencode',
        capability: task.capability,
        summary: 'unsafe patch',
        changedFiles: ['.env'],
      }),
    }),
  ]);
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'forbidden-file',
    intent: 'self-healing',
    capability: 'coding.patch',
    userInput: 'fix config',
    context: {
      rollbackFiles: async (files) => restored.push(...files),
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'POLICY_VIOLATION');
  assert.deepEqual(restored, ['.env']);
});

test('package manifest changes are accepted only when explicitly allowed', async () => {
  const registry = new AgentGatewayRegistry([
    connector('internal-coding', {
      execute: async (task) => ({
        ok: true,
        agentId: 'internal-coding',
        capability: task.capability,
        summary: 'dependency patch',
        changedFiles: ['package.json'],
      }),
    }),
  ]);
  const result = await new AgentGatewayExecutor({ registry }).execute({
    id: 'package-allowed',
    intent: 'self-upgrade',
    capability: 'coding.patch',
    userInput: 'install required dependency',
    constraints: {
      allowedPaths: ['package.json'],
      allowPackageJsonChanges: true,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.validation.ok, true);
});

test('MCP list validation rejects config/list source mismatch', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    await require('node:fs/promises').writeFile(
      configPath,
      'mcpServers:\n  filesystem:\n    command: "npx"\n',
      'utf-8'
    );
    const registry = new AgentGatewayRegistry([
      connector('mcp-agent', {
        capabilities: ['mcp.server.list'],
        execute: async (task) => ({
          ok: true,
          agentId: 'mcp-agent',
          capability: task.capability,
          summary: 'empty list',
          output: 'No MCP servers configured.',
          metadata: {
            configPath,
            serverNames: [],
          },
        }),
      }),
    ]);
    const result = await new AgentGatewayExecutor({ registry }).execute({
      id: 'mcp-list-mismatch',
      intent: 'mcp-config-read',
      capability: 'mcp.server.list',
      userInput: 'list MCP servers',
      cwd: root,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MCP_RESULT_INVALID');
    assert.match(result.error.message, /mismatch/i);
  });
});

test('MCP URL server start returns a clear unsupported transport error', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    await require('node:fs/promises').writeFile(
      configPath,
      'mcpServers:\n  remote:\n    url: "https://example.com/mcp"\n',
      'utf-8'
    );
    const service = new McpAgentService({
      enabled: true,
      allowConfigWrite: true,
      projectRoot: root,
      configPath,
    });
    const manager = new McpManager({ configPath });
    await manager.init();
    const registry = new AgentGatewayRegistry([
      new McpAgentConnector(service, manager),
    ]);
    const result = await new AgentGatewayExecutor({ registry }).execute({
      id: 'mcp-url-start',
      intent: 'mcp',
      capability: 'mcp.server.start',
      userInput: 'start MCP server remote',
      cwd: root,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'MCP_URL_TRANSPORT_UNSUPPORTED');
    assert.match(result.error.message, /URL transport/i);
  });
});

test('AgentGateway service does not execute normal chat', async () => {
  let executions = 0;
  const service = new AgentGatewayService({
    execute: async () => {
      executions += 1;
      throw new Error('normal chat must not execute AgentGateway');
    },
  });

  const result = await service.tryExecute({
    intent: 'chat',
    userInput: 'apa itu MCP?',
    source: 'web',
  });

  assert.equal(result, null);
  assert.equal(executions, 0);
});

test('AgentGateway registry initialization does not execute connectors', () => {
  let executions = 0;
  const registry = new AgentGatewayRegistry([
    connector('opencode', {
      execute: async () => {
        executions += 1;
        throw new Error('must stay on-demand');
      },
    }),
    connector('internal-coding'),
    connector('mcp-agent', { capabilities: ['mcp.config'] }),
  ]);

  assert.deepEqual(
    registry.list().map((item) => item.id).sort(),
    ['internal-coding', 'mcp-agent', 'opencode']
  );
  assert.equal(executions, 0);
});
