const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  AgentGatewayExecutor,
  AgentGatewayRegistry,
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
  assert.equal(capabilityForIntent('mcp-config-update', 'add MCP server'), 'mcp.config');
  assert.equal(capabilityForIntent('mcp-config-read', 'list MCP servers'), 'mcp.server.list');
  assert.equal(capabilityForIntent('', 'start MCP server google-sheets'), 'mcp.server.start');
  assert.equal(capabilityForIntent('', 'stop MCP server google-sheets'), 'mcp.server.stop');
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
      userInput: 'Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml. Gunakan perintah eksekusi "npx -y @modelcontextprotocol/server-google-sheets".',
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
    assert.match(await readFile(configPath, 'utf-8'), /@modelcontextprotocol\/server-google-sheets/);
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
        execute: async (task) => {
          gatewayCalls += 1;
          assert.equal(task.capability, 'mcp.config');
          return {
            ok: true,
            agentId: 'mcp-agent',
            capability: task.capability,
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
