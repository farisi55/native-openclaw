const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const childProcess = require('node:child_process');
const { readdir, readFile, writeFile } = require('node:fs/promises');
const { basename, join, relative, resolve } = require('node:path');

process.env.APP_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const {
  captureStdout,
  cliContext,
  createApiDeps,
  emptyToolRegistry,
  mockTelegramFetch,
  saveEnv,
  restoreEnv,
  withTempDirs,
  withTempWorkspace,
} = require('./helpers/workspace-qa-helpers');

const {
  WorkspaceManager,
  workspaceAppend,
  workspaceBackup,
  workspaceInfo,
  workspaceList,
  workspaceMkdir,
  workspaceRead,
  workspaceTrash,
  workspaceTree,
  workspaceWrite,
} = require('../dist/workspace');
const { buildSystemPrompt } = require('../dist/agents/prompt-builder');
const { sanitizeFinalAnswer } = require('../dist/agents/tool-loop');
const { handleAction } = require('../dist/agents/action-handler');
const { cmdWorkspace, cmdMemory, cmdHeartbeat, cmdWorkflow } = require('../dist/cli/commands');
const { getSlashCommandSuggestions } = require('../dist/cli/command-registry');
const { startApiServer } = require('../dist/api');
const { TelegramIntegration } = require('../dist/integrations');
const { ToolRegistry } = require('../dist/tools/tool-registry');
const { parseWorkflowMarkdown, validateWorkflowDefinition, runWorkflowFromWorkspace } = require('../dist/workflows');

const CORE_FILES = [
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'MEMORY.md',
  'WORKFLOW.md',
];

const CORE_DIRS = ['state', 'memory', 'reports', 'artifacts', 'backup', 'trash'];
const WORKSPACE_TOOLS = [
  'workspace-list',
  'workspace-tree',
  'workspace-read',
  'workspace-write',
  'workspace-append',
  'workspace-mkdir',
  'workspace-trash',
  'workspace-backup',
  'workspace-info',
];

function workspaceActionContext() {
  return {
    skillRegistry: { activeIds: [], all: () => [], has: () => false },
    sessions: {},
    skillsDir: resolve(process.cwd(), 'skills'),
    activeSessionId: null,
    onSessionCleared() {},
  };
}

async function postJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/native-openclaw/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function withMockedSystemExecute(fn) {
  const modulePath = require.resolve('../dist/tools/system-execute');
  const cachedModule = require.cache[modulePath];
  const originalExec = childProcess.exec;
  const calls = [];

  delete require.cache[modulePath];
  childProcess.exec = (command, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const execOptions = typeof options === 'function' ? {} : options;
    calls.push({ command, options: execOptions });
    process.nextTick(() => cb(null, 'mock stdout', ''));
    return { pid: 1, on() { return this; } };
  };

  try {
    const module = require('../dist/tools/system-execute');
    await fn(module, calls);
  } finally {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
    if (cachedModule) require.cache[modulePath] = cachedModule;
  }
}

test('should_create_workspace_structure_on_init', async () => {
  await withTempWorkspace(async (root) => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();

    assert.equal(existsSync(root), true);
    for (const dir of CORE_DIRS) {
      assert.equal(existsSync(join(root, dir)), true, `${dir} should exist`);
    }
  });
});

test('should_create_core_markdown_files_on_init', async () => {
  await withTempWorkspace(async (root) => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();

    for (const file of CORE_FILES) {
      const fullPath = join(root, file);
      assert.equal(existsSync(fullPath), true, `${file} should exist`);
      const content = await readFile(fullPath, 'utf-8');
      assert.ok(content.trim().length > 0, `${file} should be non-empty`);
    }

    assert.match(await readFile(join(root, 'AGENTS.md'), 'utf-8'), /Safety Red Lines/i);
    assert.match(await readFile(join(root, 'MEMORY.md'), 'utf-8'), /Important Facts|User Preferences|Project Decisions/i);
    assert.match(await readFile(join(root, 'WORKFLOW.md'), 'utf-8'), /Role|Objective|Topic|Data Requirements/i);
  });
});

test('should_preserve_existing_workspace_files', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();
    await workspace.write('IDENTITY.md', '# Identity\n\nName: Custom-Agent\n');

    await workspace.ensureWorkspace();

    assert.match(await workspace.read('IDENTITY.md'), /Custom-Agent/);
    assert.match(await workspace.read('MEMORY.md'), /Curated Long-Term Memory/);
  });
});

test('should_allow_safe_relative_paths_and_normalize_safe_inner_paths', async () => {
  await withTempWorkspace(async (root) => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();

    assert.equal(workspace.resolvePath('NOTES.md'), join(root, 'NOTES.md'));
    assert.equal(workspace.resolvePath('reports/test-report.md'), join(root, 'reports', 'test-report.md'));
    assert.equal(workspace.resolvePath('reports/../MEMORY.md'), join(root, 'MEMORY.md'));
  });
});

test('should_block_path_traversal_and_absolute_paths_outside_workspace', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    assert.throws(() => workspace.resolvePath('../outside.txt'), /traversal/);
    assert.throws(() => workspace.resolvePath('../../secret.txt'), /traversal/);
    assert.throws(() => workspace.resolvePath('reports/../../../outside.txt'), /traversal/);
    assert.throws(() => workspace.resolvePath('/etc/passwd'), /relative/);
    assert.throws(() => workspace.resolvePath('C:\\Users\\someone\\outside.txt'), /relative/);
  });
});

test('should_register_workspace_tools', async () => {
  await withTempWorkspace(async () => {
    const registry = new ToolRegistry(resolve(__dirname, '..'));
    await registry.loadTools();

    for (const tool of WORKSPACE_TOOLS) {
      assert.equal(registry.has(tool), true, `${tool} should be registered`);
      const runtimeTool = registry.getTool(tool);
      assert.ok(runtimeTool.manifest.inputSchema, `${tool} should expose input schema`);
    }
  });
});

test('should_write_read_append_mkdir_list_tree_trash_info_and_backup_workspace', async () => {
  await withTempWorkspace(async (root) => {
    assert.equal((await workspaceMkdir({ path: 'reports' })).ok, true);
    assert.equal((await workspaceWrite({ path: 'reports/test.md', content: 'first' })).ok, true);
    assert.equal((await workspaceAppend({ path: 'reports/test.md', content: 'second' })).ok, true);

    const read = await workspaceRead({ path: 'reports/test.md' });
    assert.match(read.content, /first/);
    assert.match(read.content, /second/);

    const list = await workspaceList({ path: 'reports' });
    assert.match(list.content, /test\.md/);

    const tree = await workspaceTree({ path: '.', maxDepth: '2' });
    assert.match(tree.content, /reports/);

    const trash = await workspaceTrash({ path: 'reports/test.md' });
    assert.match(trash.content, /trash\//);
    assert.equal(existsSync(join(root, 'reports', 'test.md')), false);
    assert.match((await workspaceList({ path: 'trash' })).content, /test\.md/);

    const info = await workspaceInfo({});
    assert.match(info.content, /Root:/);
    assert.match(info.content, /Core files:/);

    const backup = await workspaceBackup({});
    assert.match(backup.content, /backup\/workspace-backup-/);
  });
});

test('should_create_workspace_backup_without_recursion_and_include_core_files', async () => {
  await withTempWorkspace(async (root) => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();
    await workspace.write('reports/report.md', 'report');
    await workspace.write('artifacts/artifact.txt', 'artifact');

    const backupPath = await workspace.backup();
    const fullBackupPath = join(root, backupPath);

    assert.equal(existsSync(join(fullBackupPath, 'AGENTS.md')), true);
    assert.equal(existsSync(join(fullBackupPath, 'MEMORY.md')), true);
    assert.equal(existsSync(join(fullBackupPath, 'reports', 'report.md')), true);
    assert.equal(existsSync(join(fullBackupPath, 'artifacts', 'artifact.txt')), true);
    assert.equal(existsSync(join(fullBackupPath, 'backup')), false, 'backup directory must not recurse into itself');
  });
});

test('should_include_workspace_context_in_system_prompt_and_respect_limits', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();
    await workspace.write('IDENTITY.md', '# Identity\n\nName: Jarpis-Test\n');
    await workspace.write('SOUL.md', '# Soul\n\nAlways answer briefly.\n');
    await workspace.write('USER.md', '# User\n\nUser prefers Indonesian answers.\n');
    await workspace.write('MEMORY.md', '# Memory\n\nUser prefers concise technical responses.\n');
    await workspace.write('AGENTS.md', `# Agent Operating Rules\n\n${'A'.repeat(4500)}\nTAIL-SHOULD-NOT-APPEAR`);

    const workspaceContext = await workspace.buildContext({ includeWorkflow: true });
    const prompt = buildSystemPrompt({
      basePrompt: 'You are helpful.',
      skills: [],
      workspaceContext,
    });

    assert.match(prompt, /WORKSPACE CONTEXT/);
    assert.match(prompt, /Jarpis-Test/);
    assert.match(prompt, /Always answer briefly/);
    assert.match(prompt, /User prefers Indonesian answers/);
    assert.match(prompt, /User prefers concise technical responses/);
    assert.match(prompt, /\[workspace excerpt truncated\]/);
    assert.doesNotMatch(prompt, /TAIL-SHOULD-NOT-APPEAR/);
  });
});

test('should_not_expose_workspace_context_as_reasoning', () => {
  const cleaned = sanitizeFinalAnswer([
    'The user is asking who I am.',
    'From the memory, my name is Jarpis-Test.',
    'I should answer briefly.',
    'Halo, saya Jarpis-Test. Saya asisten AI lokal Native OpenClaw.',
  ].join('\n'));

  assert.equal(cleaned, 'Halo, saya Jarpis-Test. Saya asisten AI lokal Native OpenClaw.');
});

test('should_reload_workspace_context_after_file_change_and_confirm_reload_command', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();
    let context = await workspace.buildContext();
    assert.match(context, /Name: Jarpis/);

    await workspace.write('IDENTITY.md', '# Identity\n\nName: Jarpis-Reloaded\n');
    const output = await captureStdout(() => cmdWorkspace(cliContext(), ['reload']));
    assert.match(output, /next turn/i);

    context = await workspace.buildContext();
    assert.match(context, /Jarpis-Reloaded/);
  });
});

test('should_append_important_memory_to_daily_log_and_update_curated_memory_file', async () => {
  await withTempWorkspace(async () => {
    const action = await handleAction(
      'ingat bahwa saya lebih suka jawaban singkat',
      workspaceActionContext()
    );
    assert.equal(action.handled, true);

    const workspace = new WorkspaceManager();
    const longTerm = await workspace.read('MEMORY.md');
    const daily = await workspace.readDailyMemory();

    assert.match(longTerm, /lebih suka jawaban singkat/);
    assert.match(daily, /Type: user_preference/);
    assert.match(daily, /Source: chat/);
  });
});

test('should_not_log_trivial_chat_messages_and_preserve_json_memory_system', async () => {
  await withTempDirs(async ({ dataDir }) => {
    const { memory } = await createApiDeps(dataDir);
    await memory.setGlobalMemory('agentName', 'Jarpis-Json');

    const action = await handleAction('halo', workspaceActionContext());
    assert.equal(action.handled, false);

    const workspace = new WorkspaceManager();
    assert.match(await workspace.readDailyMemory(), /No daily memory log/);
    assert.equal(await memory.getGlobalValue('agentName'), 'Jarpis-Json');
  });
});

test('should_parse_memory_commands', async () => {
  await withTempWorkspace(async () => {
    const context = cliContext();
    assert.match(await captureStdout(() => cmdMemory(context, [])), /Workspace Memory/);
    assert.match(await captureStdout(() => cmdMemory(context, ['append', 'Project', 'decision', 'saved'])), /Appended/);
    assert.match(await captureStdout(() => cmdMemory(context, ['show'])), /Project decision saved/);
    assert.match(await captureStdout(() => cmdMemory(context, ['daily'])), /Daily Memory/);
    assert.match(await captureStdout(() => cmdMemory(context, ['summarize'])), /summary/i);
  });
});

test('should_route_workspace_file_request_to_workspace_tools_and_block_traversal', async () => {
  await withTempWorkspace(async (root) => {
    const context = workspaceActionContext();
    const write = await handleAction('buat file NOTES.md di workspace berisi rencana besok', context);
    assert.equal(write.handled, true);
    assert.equal(await readFile(join(root, 'NOTES.md'), 'utf-8'), 'rencana besok');

    const report = await handleAction('buat laporan singkat dan simpan di reports/test-report.md', context);
    assert.equal(report.handled, true);
    assert.equal(existsSync(join(root, 'reports', 'test-report.md')), true);

    const blocked = await handleAction('tulis file ../outside.txt', context);
    assert.equal(blocked.handled, true);
    assert.match(blocked.response, /Workspace error|traversal/);
    assert.equal(existsSync(join(root, '..', 'outside.txt')), false);
  });
});

test('should_use_configured_system_execute_default_cwd_modes', async () => {
  await withTempWorkspace(async (root) => {
    const snapshot = saveEnv(['SYSTEM_EXECUTE_DEFAULT_CWD']);
    try {
      await withMockedSystemExecute(async ({ runSystemExecute }, calls) => {
        process.env.SYSTEM_EXECUTE_DEFAULT_CWD = 'workspace';
        const workspaceResult = await runSystemExecute({ command: 'echo cwd-check' });
        assert.equal(workspaceResult.ok, true);
        assert.match(calls.at(-1).options.cwd, new RegExp(basename(root), 'i'));

        process.env.SYSTEM_EXECUTE_DEFAULT_CWD = 'project';
        const projectResult = await runSystemExecute({ command: 'echo cwd-check' });
        assert.equal(projectResult.ok, true);
        assert.equal(calls.at(-1).options.cwd, process.cwd());

        process.env.SYSTEM_EXECUTE_DEFAULT_CWD = 'current';
        const currentResult = await runSystemExecute({ command: 'echo cwd-check' });
        assert.equal(currentResult.ok, true);
        assert.equal(calls.at(-1).options.cwd, process.cwd());
      });
    } finally {
      restoreEnv(snapshot);
    }
  });
});

test('should_show_heartbeat_checklist_without_claiming_auto_execution', async () => {
  await withTempWorkspace(async () => {
    const context = cliContext();
    const show = await captureStdout(() => cmdHeartbeat(context, ['show']));
    assert.match(show, /Checklist Template/);
    assert.match(show, /not executed automatically/i);

    const run = await captureStdout(() => cmdHeartbeat(context, ['run']));
    assert.match(run, /not automatic yet/i);
  });
});

test('should_parse_workspace_commands_and_return_help_for_invalid_command', async () => {
  await withTempWorkspace(async () => {
    const context = cliContext();
    assert.match(await captureStdout(() => cmdWorkspace(context, [])), /Workspace/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['info'])), /Workspace Info/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['init'])), /initialized/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['list'])), /AGENTS\.md/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['tree'])), /IDENTITY\.md/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['read', 'IDENTITY.md'])), /Identity/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['write', 'CLI.md', 'hello'])), /Wrote/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['append', 'CLI.md', 'world'])), /Appended/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['mkdir', 'cli-folder'])), /Created/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['trash', 'CLI.md'])), /trash/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['backup'])), /backup/);
    assert.match(await captureStdout(() => cmdWorkspace(context, ['unknown'])), /Usage:/);
  });
});

test('should_read_write_and_block_workspace_paths_via_api', async () => {
  await withTempDirs(async ({ dataDir, workspaceRoot }) => {
    const { deps } = await createApiDeps(dataDir);
    const api = await startApiServer(deps, { enabled: true, host: '127.0.0.1', port: 0 });
    try {
      const read = await postJson(`http://${api.host}:${api.port}`, { message: 'baca WORKFLOW.md' });
      assert.equal(read.status, 200);
      assert.equal(read.body.error_detail.length, 0);
      assert.match(read.body.result, /Workflow:/);

      const write = await postJson(`http://${api.host}:${api.port}`, {
        message: 'buat file NOTES.md di workspace berisi test dari API',
      });
      assert.equal(write.status, 200);
      assert.equal(existsSync(join(workspaceRoot, 'NOTES.md')), true);
      assert.equal(await readFile(join(workspaceRoot, 'NOTES.md'), 'utf-8'), 'test dari API');

      const blocked = await postJson(`http://${api.host}:${api.port}`, { message: 'tulis file ../outside.txt' });
      assert.equal(blocked.status, 200);
      assert.match(`${blocked.body.result} ${blocked.body.error_detail.join(' ')}`, /Workspace error|traversal/);
      assert.equal(existsSync(join(workspaceRoot, '..', 'outside.txt')), false);
    } finally {
      await api.close();
    }
  });
});

test('should_list_update_memory_and_block_traversal_via_telegram_handler', async () => {
  await withTempDirs(async ({ dataDir, workspaceRoot }) => {
    const { deps } = await createApiDeps(dataDir);
    const sent = [];
    const actions = [];
    const restoreFetch = mockTelegramFetch(sent, actions);
    try {
      const integration = new TelegramIntegration(
        deps,
        {
          enabled: true,
          botToken: 'test-token',
          allowedChatIds: new Set(['123']),
          allowAll: false,
          ackEnabled: true,
          ackMessage: 'Sedang diproses...',
          processTimeoutMs: 90000,
        },
        dataDir
      );

      assert.equal(await integration.handleIncomingText('123', 'lihat isi workspace'), true);
      assert.match(sent.at(-1).text, /AGENTS\.md/);

      assert.equal(await integration.handleIncomingText('123', 'simpan ini ke MEMORY.md: saya lebih suka jawaban singkat'), true);
      assert.match(await readFile(join(workspaceRoot, 'MEMORY.md'), 'utf-8'), /jawaban singkat/);
      assert.match(await new WorkspaceManager().readDailyMemory(), /user_preference/);

      assert.equal(await integration.handleIncomingText('123', 'tulis file ../outside.txt'), true);
      assert.match(sent.at(-1).text, /Workspace error|traversal/);
      assert.equal(existsSync(join(workspaceRoot, '..', 'outside.txt')), false);
    } finally {
      restoreFetch();
    }
  });
});

test('should_validate_show_and_run_workflow_from_workspace_file_without_hardcoded_topic', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();
    await workspace.write('WORKFLOW.md', [
      '# Workflow: Daily Oil Price Report',
      '',
      '## Role',
      'You are an autonomous energy market analyst.',
      '',
      '## Objective',
      'Generate a daily oil market report.',
      '',
      '## Topic',
      'Harga minyak Brent dan WTI hari ini',
      '',
      '## Data Requirements',
      '- Search Brent crude oil price today',
      '- Search WTI crude oil price today',
      '',
      '## Analysis Requirements',
      '- Compare Brent vs WTI',
      '- Summarize trend',
      '',
      '## Output Requirements',
      '- Generate professional HTML report',
      '- Save report to workspace/reports',
      '',
      '## Email',
      'sendEmail: false',
      'subject: "[LAPORAN] Harga Minyak Dunia - {{date}}"',
      '',
      '## Safety Rules',
      '- Do not fabricate prices or data',
      '- Always cite source URLs when available',
    ].join('\n'));

    const parsed = parseWorkflowMarkdown(await workspace.read('WORKFLOW.md'));
    assert.deepEqual(validateWorkflowDefinition(parsed), []);

    const show = await captureStdout(() => cmdWorkflow(cliContext({ toolRegistry: emptyToolRegistry() }), ['show']));
    assert.match(show, /Daily Oil Price Report/);
    assert.match(show, /Harga minyak Brent/);

    const result = await runWorkflowFromWorkspace({
      workspace,
      toolRegistry: emptyToolRegistry(),
      now: new Date('2026-05-20T00:00:00.000Z'),
    });
    assert.equal(result.topic, 'Harga minyak Brent dan WTI hari ini');
    assert.doesNotMatch(result.topic, /emas|Antam|XAU/i);
    assert.ok(result.generatedFiles.some((file) => file.path.startsWith('reports/') && file.type === 'html'));
    assert.equal(existsSync(workspace.resolvePath('reports/daily-oil-price-report-2026-05-20.html')), true);
  });
});

test('should_not_expose_env_secrets_or_delete_permanently_by_default', async () => {
  await withTempWorkspace(async (root) => {
    const snapshot = saveEnv(['BREVO_API_KEY']);
    process.env.BREVO_API_KEY = 'super-secret-api-key';
    try {
      const info = await workspaceInfo({});
      assert.doesNotMatch(info.content, /super-secret-api-key/);

      const action = await handleAction('halo', workspaceActionContext());
      assert.equal(action.handled, false);

      const workspace = new WorkspaceManager();
      await workspace.write('delete-me.txt', 'keep recoverable');
      await workspace.trash('delete-me.txt');
      assert.equal(existsSync(join(root, 'delete-me.txt')), false);
      const trashFiles = await readdir(join(root, 'trash'));
      assert.ok(trashFiles.some((file) => file.includes('delete-me.txt')));
    } finally {
      restoreEnv(snapshot);
    }
  });
});

test('should_include_workspace_and_memory_commands_in_autocomplete', () => {
  const workspaceCommands = getSlashCommandSuggestions('/w').map((item) => item.command);
  assert.ok(workspaceCommands.includes('/workspace'));
  assert.ok(workspaceCommands.includes('/workspace list'));
  assert.ok(workspaceCommands.includes('/workspace read'));
  assert.ok(workspaceCommands.includes('/workspace write'));
  assert.ok(workspaceCommands.includes('/workspace append'));
  assert.ok(workspaceCommands.includes('/workspace mkdir'));
  assert.ok(workspaceCommands.includes('/workspace backup'));
  assert.ok(workspaceCommands.includes('/workspace reload'));
  assert.equal(workspaceCommands.includes('/workspace restore'), false);

  const memoryCommands = getSlashCommandSuggestions('/mem').map((item) => item.command);
  assert.ok(memoryCommands.includes('/memory'));
  assert.ok(memoryCommands.includes('/memory show'));
  assert.ok(memoryCommands.includes('/memory append'));
  assert.ok(memoryCommands.includes('/memory daily'));
  assert.ok(memoryCommands.includes('/memory summarize'));
});

test('should_handle_platform_paths_safely', async () => {
  await withTempWorkspace(async () => {
    const workspace = new WorkspaceManager();
    await workspace.ensureWorkspace();

    const safe = workspace.resolvePath(join('reports', 'portable.md'));
    assert.ok(relative(workspace.rootDir, safe).startsWith('reports'));

    assert.throws(() => workspace.resolvePath('..\\outside.txt'), /traversal/);
    assert.throws(() => workspace.resolvePath('../outside.txt'), /traversal/);
  });
});
