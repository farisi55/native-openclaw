const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  assessMcpCommand,
  createNpmPackageValidator,
  getBinaryLookupCommand,
  getGlobalNpmRoot,
  getKnownMcpServerAlias,
  getNpmCommand,
  getNpxCommand,
  KNOWN_MCP_SERVER_ALIASES,
  McpManager,
  normalizeMcpStartError,
  resolveKnownMcpServerAlias,
  resolveKnownMcpServerAliasRuntime,
  resolveMcpCommand,
  resolveBinaryOnPath,
} = require('../dist/mcp');
const {
  McpAgentService,
  parseMcpConfigurationInstruction,
} = require('../dist/mcp-agent');
const { cmdMcp } = require('../dist/cli/commands');

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'native-openclaw-mcp-phase36-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function captureStdout(fn) {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk, ...args) => {
    output += String(chunk);
    const callback = args.find((arg) => typeof arg === 'function');
    if (callback) callback();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return output.replace(/\x1b\[[0-9;]*m/g, '');
}

function cliContext(manager) {
  return {
    providers: new Map(),
    skillRegistry: { activeIds: [], size: 0 },
    sessions: {},
    settings: {},
    toolRegistry: { listTools: () => [] },
    mcpManager: manager,
    activeProvider: {},
    activeModel: 'test',
    activeSessionId: null,
    setProvider() {},
    setModel() {},
    async setSession() {},
  };
}

test('command resolver allows safe launchers and absolute paths', async () => {
  for (const command of ['npx', 'node']) {
    const result = await resolveMcpCommand(command);
    assert.equal(result.valid, true);
    assert.equal(result.command, command);
  }

  const absolute = await resolveMcpCommand('/usr/local/bin/mcp-server-everything');
  assert.equal(absolute.valid, true);
  assert.equal(absolute.command, '/usr/local/bin/mcp-server-everything');
});

test('command resolver rejects arbitrary bare commands with an actionable suggestion', async () => {
  const result = await resolveMcpCommand('curl');
  assert.equal(result.valid, false);
  assert.match(result.reason, /not allowed as a bare command/i);
  assert.match(result.suggestion, /absolute binary path/i);
});

test('command resolver resolves known MCP binaries with a mocked which lookup', async () => {
  const result = await resolveMcpCommand(
    'mcp-server-everything',
    async (command) => {
      assert.equal(command, 'mcp-server-everything');
      return '/usr/local/bin/mcp-server-everything';
    }
  );
  assert.equal(result.valid, true);
  assert.equal(result.resolved, true);
  assert.equal(result.command, '/usr/local/bin/mcp-server-everything');
});

test('known MCP binary returns install and node-path guidance when unresolved', async () => {
  const result = await resolveMcpCommand(
    'mcp-server-everything',
    async () => undefined
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /could not be resolved/i);
  assert.match(result.suggestion, /npm install -g @modelcontextprotocol\/server-everything/i);
  assert.match(result.suggestion, /dist\/index\.js/i);
});

test('/mcp list shows valid servers and warns for an invalid launcher', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    await writeFile(configPath, [
      'mcpServers:',
      '  valid:',
      '    command: "node"',
      '    args: ["server.js"]',
      '  invalid:',
      '    command: "curl"',
      '    args: ["https://example.com"]',
      '',
    ].join('\n'));
    const manager = new McpManager({ configPath });
    await manager.init();

    const servers = await manager.listServers();
    assert.equal(servers.find((server) => server.name === 'valid').status, 'stopped');
    assert.equal(servers.find((server) => server.name === 'invalid').status, 'invalid');

    const output = await captureStdout(() => cmdMcp(cliContext(manager), ['list']));
    assert.match(output, /valid/);
    assert.match(output, /invalid/);
    assert.match(output, /Reason:/);
    assert.match(output, /Suggestion:/);
  });
});

test('MCP start errors are normalized for npm 404, cache EACCES, and initialize timeout', () => {
  const notFound = normalizeMcpStartError(
    new Error("npm error code E404\n'@missing/server@*' is not in this registry.")
  );
  assert.match(notFound.message, /npm package was not found/i);
  assert.match(notFound.message, /server-everything/i);

  const permissions = normalizeMcpStartError(
    new Error('npm error code EACCES\nnpm error path /home/openclaw/.npm/_cacache/tmp')
  );
  assert.match(permissions.message, /npm cache is not writable/i);
  assert.match(permissions.message, /chown -R 100:101/i);

  const timeout = normalizeMcpStartError(new Error('MCP request timed out: initialize'));
  assert.match(timeout.message, /MCP initialize timed out/i);
  assert.match(timeout.message, /npx cold install/i);
});

test('alias registry uses safe smoke servers and a real auth-required Google Sheets package', () => {
  const everything = getKnownMcpServerAlias('everything');
  const filesystem = getKnownMcpServerAlias('filesystem');
  const sheets = getKnownMcpServerAlias('google-sheets');

  assert.equal(everything.packageName, '@modelcontextprotocol/server-everything');
  assert.equal(filesystem.packageName, '@modelcontextprotocol/server-filesystem');
  assert.deepEqual(filesystem.fallbackArgs.slice(-1), ['/workspace']);
  assert.equal(sheets.packageName, '@node2flow/google-sheets-mcp');
  assert.equal(sheets.requiresAuth, true);
  assert.doesNotMatch(JSON.stringify(KNOWN_MCP_SERVER_ALIASES), /server-google-sheets/);

  const globallyInstalled = resolveKnownMcpServerAlias(
    'everything',
    (path) => path.endsWith('/dist/index.js')
  );
  assert.equal(globallyInstalled.config.command, 'node');

  const fallback = resolveKnownMcpServerAlias('everything', () => false);
  assert.equal(fallback.config.command, 'npx');

  const naturalLanguage = parseMcpConfigurationInstruction('add mcp everything');
  assert.equal(naturalLanguage.action, 'configure');
  assert.equal(naturalLanguage.serverName, 'everything');
  assert.equal(naturalLanguage.command, undefined);
});

test('natural-language MCP aliases parse without requiring command arguments', () => {
  const cases = [
    ['add mcp everything', 'everything'],
    ['add mcp server everything', 'everything'],
    ['tambahkan MCP everything', 'everything'],
    ['tambahkan MCP everything untuk smoke test', 'everything'],
    ['tambahkan server MCP filesystem', 'filesystem'],
    ['daftarkan MCP filesystem', 'filesystem'],
    ['register MCP everything', 'everything'],
  ];

  for (const [input, expectedServer] of cases) {
    const parsed = parseMcpConfigurationInstruction(input);
    assert.equal(parsed.action, 'configure', input);
    assert.equal(parsed.serverName, expectedServer, input);
    assert.equal(parsed.command, undefined, input);
  }
});

test('runtime alias resolver builds cross-platform node configs from global npm root', async () => {
  const windowsRoot = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules';
  const everything = await resolveKnownMcpServerAliasRuntime('everything', {
    platform: 'win32',
    globalNpmRootResolver: async () => windowsRoot,
    fileExists: () => true,
  });
  assert.equal(everything.config.command, 'node');
  assert.equal(
    everything.config.args[0],
    `${windowsRoot}\\@modelcontextprotocol\\server-everything\\dist\\index.js`
  );

  const filesystem = await resolveKnownMcpServerAliasRuntime('filesystem', {
    platform: 'linux',
    workspacePath: '/workspace/project',
    globalNpmRootResolver: async () => '/usr/local/lib/node_modules',
    fileExists: () => true,
  });
  assert.equal(filesystem.config.command, 'node');
  assert.deepEqual(filesystem.config.args, [
    '/usr/local/lib/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
    '/workspace/project',
  ]);
});

test('Windows helpers use npm.cmd, npx.cmd, and where.exe without spawn EINVAL', async () => {
  assert.equal(getNpmCommand('win32'), 'npm.cmd');
  assert.equal(getNpxCommand('win32'), 'npx.cmd');
  assert.equal(getBinaryLookupCommand('win32'), 'where.exe');

  let npmCommand = '';
  const root = await getGlobalNpmRoot({
    platform: 'win32',
    runner: async (command, args) => {
      npmCommand = command;
      assert.deepEqual(args, ['root', '-g']);
      return {
        stdout: 'C:\\npm\\node_modules\r\n',
        stderr: '',
      };
    },
  });
  assert.equal(npmCommand, 'npm.cmd');
  assert.equal(root, 'C:\\npm\\node_modules');

  const validator = createNpmPackageValidator({
    platform: 'win32',
    runner: async (command, args) => {
      assert.equal(command, 'npm.cmd');
      assert.deepEqual(args, [
        'view',
        '@modelcontextprotocol/server-everything',
        'version',
        '--json',
      ]);
      return { stdout: '"1.2.3"\n', stderr: '' };
    },
  });
  assert.deepEqual(
    await validator('@modelcontextprotocol/server-everything', 15_000),
    {
      ok: true,
      packageName: '@modelcontextprotocol/server-everything',
      version: '1.2.3',
    }
  );

  let lookupExecutable = '';
  const binary = await resolveBinaryOnPath('mcp-server-everything', {
    platform: 'win32',
    execFileImpl: (executable, args, options, callback) => {
      lookupExecutable = executable;
      assert.deepEqual(args, ['mcp-server-everything']);
      callback(null, 'C:\\npm\\mcp-server-everything.cmd\r\n', '');
      return {};
    },
  });
  assert.equal(lookupExecutable, 'where.exe');
  assert.equal(binary, 'C:\\npm\\mcp-server-everything.cmd');
});

test('alias-only MCP Agent instruction writes deterministic known server config', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    const everythingEntry = join(
      'C:\\npm\\node_modules',
      '@modelcontextprotocol',
      'server-everything',
      'dist',
      'index.js'
    );
    const service = new McpAgentService(
      {
        enabled: true,
        allowConfigWrite: true,
        projectRoot: root,
        configPath,
        validateNpmPackage: true,
      },
      {
        aliasResolver: async (serverName) => ({
          name: serverName,
          alias: getKnownMcpServerAlias(serverName),
          config: {
            command: 'node',
            args: [everythingEntry],
          },
          usingFallback: false,
        }),
      }
    );

    const result = await service.handleInstruction(
      'tambahkan MCP everything untuk smoke test'
    );
    assert.equal(result.serverName, 'everything');
    assert.equal(result.after.command, 'node');
    assert.deepEqual(result.after.args, [everythingEntry]);
    assert.match(await readFile(configPath, 'utf-8'), /everything:/);
  });
});

test('spawn EINVAL is normalized without exposing the raw platform error', () => {
  const normalized = normalizeMcpStartError(new Error('spawn EINVAL'));
  assert.doesNotMatch(normalized.message, /spawn EINVAL/i);
  assert.match(normalized.message, /failed while resolving MCP server command/i);
  assert.match(normalized.message, /npm install -g @modelcontextprotocol\/server-everything/i);
});

test('MCP Agent rejects the known nonexistent Google Sheets package before writing config', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    const service = new McpAgentService({
      enabled: true,
      allowConfigWrite: true,
      projectRoot: root,
      configPath,
      validateNpmPackage: true,
    });

    await assert.rejects(
      service.configureServer({
        serverName: 'google-sheets',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-google-sheets'],
      }),
      /Package not found in npm registry/i
    );
    await assert.rejects(readFile(configPath, 'utf-8'), /ENOENT/);
  });
});

test('runtime inventory can diagnose invalid commands but config APIs do not create them', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    const manager = new McpManager({ configPath });
    await manager.init();
    await assert.rejects(
      manager.addServer('unsafe', { command: 'curl', args: ['https://example.com'] }),
      /not allowed as a bare command/i
    );

    const service = new McpAgentService({
      enabled: true,
      allowConfigWrite: true,
      projectRoot: root,
      configPath,
      validateNpmPackage: false,
    });
    await assert.rejects(
      service.configureServer({
        serverName: 'unsafe',
        command: 'curl',
        args: ['https://example.com'],
      }),
      /not allowed as a bare command/i
    );
  });
});

test('MCP Agent package preflight blocks registry 404 and disabled validation emits warning', async () => {
  await withTempDir(async (root) => {
    const configPath = join(root, 'mcp_agent.config.yaml');
    let validationCalls = 0;
    const service = new McpAgentService(
      {
        enabled: true,
        allowConfigWrite: true,
        projectRoot: root,
        configPath,
        validateNpmPackage: true,
        npmValidateTimeoutMs: 1234,
      },
      {
        npmPackageValidator: async (packageName, timeoutMs) => {
          validationCalls += 1;
          assert.equal(packageName, '@missing/mcp-server');
          assert.equal(timeoutMs, 1234);
          return {
            ok: false,
            packageName,
            error: 'npm error code E404',
          };
        },
      }
    );
    await assert.rejects(
      service.configureServer({
        serverName: 'missing',
        command: 'npx',
        args: ['-y', '@missing/mcp-server'],
      }),
      /Package not found in npm registry/i
    );
    assert.equal(validationCalls, 1);

    const unverified = new McpAgentService({
      enabled: true,
      allowConfigWrite: true,
      projectRoot: root,
      configPath,
      validateNpmPackage: false,
    });
    const result = await unverified.configureServer({
      serverName: 'unverified',
      command: 'npx',
      args: ['-y', '@unverified/mcp-server'],
    });
    assert.match(result.warnings.join(' '), /was not verified/i);
  });
});

test('Docker runtime permanently provisions a writable npm cache and optional smoke servers', async () => {
  const [dockerfile, entrypoint, compose] = await Promise.all([
    readFile(join(process.cwd(), 'Dockerfile'), 'utf-8'),
    readFile(join(process.cwd(), 'entrypoint.sh'), 'utf-8'),
    readFile(join(process.cwd(), 'docker-compose.yml'), 'utf-8'),
  ]);

  assert.match(dockerfile, /ENV NPM_CONFIG_CACHE=\/home\/openclaw\/\.npm/);
  assert.match(dockerfile, /\/home\/openclaw\/\.npm\/_logs/);
  assert.match(dockerfile, /MCP_SMOKE_SERVERS_INSTALL=false/);
  assert.match(dockerfile, /@modelcontextprotocol\/server-everything/);
  assert.match(entrypoint, /mkdir -p \/home\/openclaw\/\.npm\/_logs/);
  assert.match(entrypoint, /chown -R openclaw:openclaw \/home\/openclaw\/\.npm/);
  assert.match(compose, /MCP_SMOKE_SERVERS_INSTALL: \$\{MCP_SMOKE_SERVERS_INSTALL:-false\}/);
});

test('arbitrary dangerous bare commands remain invalid', () => {
  for (const command of ['rm', 'bash', 'sh', 'curl', 'wget', 'sudo', 'docker']) {
    const assessment = assessMcpCommand(command);
    assert.equal(assessment.valid, false, command);
  }
});
