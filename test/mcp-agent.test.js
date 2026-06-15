const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  McpAgentService,
  parseMcpConfigurationInstruction,
} = require('../dist/mcp-agent');
const { getNpxCommand, McpManager } = require('../dist/mcp');
const { handleAction } = require('../dist/agents/action-handler');

async function withService(fn) {
  const root = await mkdtemp(join(tmpdir(), 'native-openclaw-mcp-agent-'));
  const service = new McpAgentService({
    enabled: true,
    allowConfigWrite: true,
    projectRoot: root,
    configPath: './mcp_agent.config.yaml',
    validateNpmPackage: false,
  });
  try {
    await fn({ root, service, configPath: join(root, 'mcp_agent.config.yaml') });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function actionContext(service) {
  return {
    skillRegistry: {
      all: () => [],
      has: () => false,
      activeIds: [],
    },
    sessions: {},
    skillsDir: './skills',
    activeSessionId: null,
    mcpAgent: service,
    selfHealing: {
      healingEnabled: true,
      upgradeEnabled: true,
      runsDir: './workspace/self-healing/runs',
      healingEngine: {
        async run() {
          throw new Error('self-healing must not run for MCP self-configuration');
        },
      },
      upgradeEngine: {
        async run() {
          throw new Error('self-upgrade must not run for MCP self-configuration');
        },
      },
    },
    onSessionCleared() {},
  };
}

test('creates missing YAML and adds the auth-required google-sheets alias', async () => {
  await withService(async ({ service, configPath }) => {
    const npxCommand = getNpxCommand(process.platform);
    const result = await service.configureServer({
      serverName: 'Google Sheets',
    });

    assert.equal(result.action, 'created');
    assert.equal(result.serverName, 'google-sheets');
    const yaml = await readFile(configPath, 'utf-8');
    assert.match(yaml, /google-sheets:/);
    assert.match(yaml, new RegExp(`command: "${npxCommand.replace('.', '\\.')}"`));
    assert.match(yaml, /@node2flow\/google-sheets-mcp/);
    assert.match(result.warnings.join(' '), /requires authentication/i);
  });
});

test('runtime manager sees self-configured servers without restart', async () => {
  await withService(async ({ service, configPath }) => {
    const npxCommand = getNpxCommand(process.platform);
    const manager = new McpManager({ configPath });
    await manager.init();
    assert.deepEqual(await manager.listServers(), []);

    await service.configureServer({
      serverName: 'google-sheets',
    });

    const servers = await manager.listServers();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'google-sheets');
    assert.equal(servers[0].command, npxCommand);
    assert.deepEqual(servers[0].args, ['-y', '@node2flow/google-sheets-mcp']);
  });
});

test('preserves existing command and URL servers', async () => {
  await withService(async ({ service, configPath }) => {
    await writeFile(configPath, [
      'mcpServers:',
      '  filesystem:',
      '    command: "npx"',
      '    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]',
      '  canva:',
      '    url: "https://canva.com"',
      '',
    ].join('\n'));

    await service.configureServer({
      serverName: 'google-sheets',
      command: 'npx',
      args: ['-y', '@node2flow/google-sheets-mcp'],
    });
    const listed = await service.listServers();
    assert.deepEqual(Object.keys(listed.servers), ['filesystem', 'canva', 'google-sheets']);
    assert.equal(listed.servers.canva.url, 'https://canva.com');
  });
});

test('updates changed server and returns unchanged for identical definition', async () => {
  await withService(async ({ service }) => {
    await service.configureServer({
      serverName: 'google-sheets',
      command: 'npx',
      args: ['-y', 'old-package'],
    });
    const updated = await service.configureServer({
      serverName: 'google-sheets',
      command: 'npx',
      args: ['-y', '@node2flow/google-sheets-mcp'],
    });
    const unchanged = await service.configureServer({
      serverName: 'google-sheets',
      command: 'npx',
      args: ['-y', '@node2flow/google-sheets-mcp'],
    });

    assert.equal(updated.action, 'updated');
    assert.equal(unchanged.action, 'unchanged');
  });
});

test('supports URL servers, list, and remove operations', async () => {
  await withService(async ({ service }) => {
    const created = await service.configureServer({
      serverName: 'Canva',
      url: 'https://canva.com',
    });
    const listed = await service.handleInstruction(
      'list MCP server yang tersedia di mcp_agent.config.yaml'
    );
    const removed = await service.handleInstruction(
      'hapus MCP server canva dari file mcp_agent.config.yaml'
    );

    assert.equal(created.action, 'created');
    assert.equal(listed.action, 'listed');
    assert.equal(listed.servers.canva.url, 'https://canva.com');
    assert.equal(removed.action, 'removed');
    assert.doesNotMatch(removed.yamlPreview, /canva:/);
  });
});

test('rejects invalid names, definitions, and path traversal', async () => {
  await withService(async ({ service }) => {
    await assert.rejects(
      service.configureServer({ serverName: '../secret', command: 'npx' }),
      /server name is invalid/i
    );
    await assert.rejects(
      service.configureServer({ serverName: 'broken', command: '', url: '' }),
      /either command or url/i
    );
    await assert.rejects(
      service.configureServer({ serverName: 'broken', url: 'ftp://example.com' }),
      /http or https/i
    );
    await assert.rejects(
      service.configureServer({
        serverName: 'escape',
        command: 'npx',
        configPath: '../../outside.yaml',
      }),
      /inside the project root/i
    );
  });
});

test('parses Indonesian and English command instructions', () => {
  const indonesian = parseMcpConfigurationInstruction(
    'Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml. Gunakan perintah eksekusi "npx -y @node2flow/google-sheets-mcp".'
  );
  const english = parseMcpConfigurationInstruction(
    'add MCP server google-sheets to mcp_agent.config.yaml using command "npx -y @node2flow/google-sheets-mcp"'
  );

  for (const parsed of [indonesian, english]) {
    assert.equal(parsed.action, 'configure');
    assert.equal(parsed.serverName, 'google-sheets');
    assert.equal(parsed.command, 'npx');
    assert.deepEqual(parsed.args, ['-y', '@node2flow/google-sheets-mcp']);
  }
});

test('action handler uses self-configuration and never enters self-healing', async () => {
  await withService(async ({ service }) => {
    const input = 'Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml. Gunakan perintah eksekusi "npx -y @node2flow/google-sheets-mcp".';
    const result = await handleAction(input, actionContext(service), {
      originalInput: input,
      optimizedInput: input,
      intent: 'mcp-config-update',
      routingHint: 'self-configuration',
      tokenBudget: {
        estimatedInputChars: input.length,
        maxInputChars: 24000,
        compressionApplied: false,
      },
      requiredTools: ['mcp-agent.configure-server'],
      excludedTools: ['SelfHealingEngine', 'SelfUpgradeEngine'],
      metadata: {},
    });

    assert.equal(result.handled, true);
    assert.equal(result.actionType, 'self_configuration');
    assert.match(result.response, /google-sheets/);
    assert.match(result.response, /```yaml/);
  });
});
