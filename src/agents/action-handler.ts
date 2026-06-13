/**
 * agents/action-handler.ts
 * Rule-based action interceptor.
 *
 * Intercepts specific user inputs BEFORE they reach the LLM and
 * executes internal functions instead. Keeps the agent feeling
 * responsive for common management operations.
 *
 * Supported patterns (case-insensitive):
 *   "list skills"
 *   "use skill <id>"
 *   "install skill <id>"   (alias for use skill — loads from disk & activates)
 *   "disable skill <id>"
 *   "delete session <id>"
 */

import type { SkillRegistry } from '../skills/registry';
import type { SessionManager } from '../storage/session-manager';
import type { McpManager } from '../mcp';
import { validateMcpConfigFile } from '../mcp';
import {
  isMcpConfigurationIntent,
  type McpAgentActionResult,
  type McpAgentService,
} from '../mcp-agent';
import { loadSkillFromFile } from '../skills/loader';
import { WorkspaceManager } from '../workspace';
import { handleSchedulerText, type SchedulerActionContext } from '../scheduler';
import { handleSelfImprovingAction, type SelfImprovingActionContext } from '../skills/self-improving-actions';
import {
  handleSelfHealingAction,
  isInformationalCapabilityQuestion,
  isSelfUpgradeIntent,
  type SelfHealingActionContext,
} from '../self-healing';
import { approveCommand, rejectCommand } from '../tools/system-execute';
import { approveOpenCodeInstall, rejectOpenCodeInstall, type OpenCodeInstallResult } from '../tools/opencode-installer';
import { runOpenCodeDoctor, type OpenCodeDoctorResult } from '../tools/opencode-agent';
import {
  applicationDebugDiagnostic,
  isApplicationDebugFixRequest,
  isApplicationDebugRequest,
  telegramPollingLogFixInstruction,
} from './application-debug-intent';
import { join } from 'path';
import { createLogger } from '../utils/logger';
import type { CompiledPrompt } from '../prompt-optimizer';
import {
  capabilityForIntent,
  createAgentTaskId,
  type AgentGatewayExecutor,
} from '../agent-gateway';

const logger = createLogger('agent:action-handler');

function capabilityExplanationResponse(): string {
  return [
    'Ini tiga fitur otonom Native OpenClaw:',
    '',
    '- Self-improvement: belajar dari workflow yang berhasil, membuat reusable skill, melacak kualitas skill, dan memperbaiki skill yang performanya rendah.',
    '- Self-healing: menganalisis bug/error, mengubah kode secara terbatas, menjalankan build/test, mengulang sampai batas loop, lalu rollback kalau tetap gagal.',
    '- Self-upgrade: menambahkan kemampuan, tool, atau mekanisme baru lewat perubahan kode, QA otomatis, dan restart opsional setelah lulus.',
    '',
    'Tidak ada engine otonom yang dijalankan untuk pertanyaan penjelasan seperti ini.',
  ].join('\n');
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionContext {
  skillRegistry: SkillRegistry;
  sessions: SessionManager;
  /** Absolute path to the skills directory. */
  skillsDir: string;
  /** Currently active session ID (may be null). */
  activeSessionId: string | null;
  /** Optional MCP manager for MCP install/add natural-language actions. */
  mcpManager?: McpManager;
  /** Deterministic MCP YAML self-configuration service. */
  mcpAgent?: McpAgentService;
  /** Lightweight connector gateway for coding and MCP delegation. */
  agentGateway?: AgentGatewayExecutor;
  /** Optional scheduler action context for natural-language cronjob management. */
  scheduler?: SchedulerActionContext;
  /** Optional self-improvement action context for management commands. */
  selfImproving?: SelfImprovingActionContext;
  /** Optional autonomous self-healing/self-upgrade action context. */
  selfHealing?: SelfHealingActionContext;
  /** Called when the active session must be cleared (e.g. after delete). */
  onSessionCleared: () => void;
}

export interface ActionResult {
  /** true = action was handled; false = pass to LLM */
  handled: boolean;
  /** Text response to display to the user (when handled = true). */
  response?: string;
  /** Type of handled action, used by non-blocking learning hooks. */
  actionType?: 'scheduler_create' | 'scheduler_manage' | 'self_improve' | 'self_healing' | 'self_upgrade' | 'self_configuration' | 'command' | 'capability' | 'other';
}

// ─── Pattern matchers ─────────────────────────────────────────────────────────

const LIST_SKILLS    = /^list\s+skills?$/i;
const USE_SKILL      = /^(?:use|activate|enable)\s+skill\s+(.+)$/i;
const INSTALL_SKILL  = /^install\s+skill\s+(.+)$/i;
const DISABLE_SKILL  = /^(?:disable|deactivate|remove)\s+skill\s+(.+)$/i;
const DELETE_SESSION = /^delete\s+session\s+([a-f0-9-]{4,36})$/i;
const ADD_MCP        = /^(?:install|add|use)\s+mcp\s+(.+)$/i;
const ADD_MCP_CONFIG = /^add\s+this\s+mcp\s+config\s*:\s*(\{[\s\S]+\})$/i;
const WORKSPACE_LIST = /^(?:lihat|tampilkan|list|show)\s+(?:isi\s+)?workspace$/i;
const WORKSPACE_BACKUP = /^(?:backup|cadangkan)\s+workspace(?:\s+sekarang)?$/i;
const WORKSPACE_READ = /^(?:baca|read|lihat)\s+([A-Za-z0-9_.\-/\\]+\.md)$/i;
const WORKSPACE_MKDIR = /^(?:buat|create|mkdir)\s+folder\s+([A-Za-z0-9_.\-/\\]+)$/i;
const MEMORY_NOTE = /^(?:simpan\s+ini\s+ke\s+MEMORY\.md|catat\s+(?:keputusan\s+ini\s+)?sebagai\s+memory|ingat\s+bahwa)\s*:?\s+(.+)$/i;
const USER_UPDATE = /^update\s+USER\.md\s+bahwa\s+(.+)$/i;
const WORKSPACE_WRITE = /^(?:buat|create|tulis|write)\s+file\s+([A-Za-z0-9_.\-/\\]+)(?:\s+di\s+workspace)?\s+berisi\s+([\s\S]+)$/i;
const WORKSPACE_WRITE_WITHOUT_CONTENT = /^(?:tulis|write)\s+file\s+([^\s]+)$/i;
const REPORT_SAVE = /^(?:buat\s+laporan|buat\s+report)[\s\S]*?\s+simpan\s+di\s+([A-Za-z0-9_.\-/\\]+)$/i;
const APPROVE_COMMAND = /^(?:approve|setujui|izinkan)\s+command\s+([A-Za-z0-9_-]+)$/i;
const REJECT_COMMAND = /^(?:reject|tolak|batalkan)\s+command\s+([A-Za-z0-9_-]+)$/i;
const APPROVE_OPENCODE_INSTALL = /^(?:approve|setujui|izinkan)\s+opencode\s+install\s+([A-Za-z0-9_-]+)$/i;
const REJECT_OPENCODE_INSTALL = /^(?:reject|tolak|batalkan)\s+opencode\s+install\s+([A-Za-z0-9_-]+)$/i;
const OPENCODE_DOCTOR = /^\/?opencode\s+doctor(?:\s+(--smoke))?$/i;

function formatOpenCodeInstallResult(result: OpenCodeInstallResult): string {
  if (!result.ok) {
    return result.error ?? 'OpenCode installation was not executed.';
  }
  return [
    'OpenCode installation completed.',
    '',
    `Strategy: ${result.strategy}`,
    'Command:',
    result.command,
    '',
    result.detectedAfterInstall?.installed
      ? `Detected version: ${result.detectedAfterInstall.version ?? 'unknown'}`
      : 'OpenCode detection after install was not available.',
  ].join('\n');
}

function formatOpenCodeDoctorResult(result: OpenCodeDoctorResult): string {
  const existingConfigs = result.configFiles.filter((config) => config.exists);
  const lines = [
    result.ok ? 'OpenCode doctor passed.' : 'OpenCode doctor found issues.',
    '',
    `Installed: ${result.installed ? 'yes' : 'no'}`,
    `Command: ${result.command}`,
    result.version ? `Version: ${result.version}` : '',
    `Resolved cwd: ${result.cwd}`,
    `Cwd valid: ${result.cwdValid ? 'yes' : 'no'} (${result.cwdReason})`,
    `Args template: ${result.argsTemplate}`,
    `Args preview: ${JSON.stringify(result.argsPreview)}`,
    `Direct mode: ${result.directMode ? 'enabled' : 'disabled'}`,
    `Inject safety preamble: ${result.injectSafetyPreamble ? 'yes' : 'no'}`,
    `Hard timeout ms: ${result.hardTimeoutMs}`,
    `Idle timeout ms: ${result.idleTimeoutMs}`,
    `Template valid: ${result.templateValid ? 'yes' : 'no'}`,
    `Prompt mode: ${result.promptMode}`,
    `Dangerous skip permissions: ${result.dangerousSkipPermissions ? 'enabled' : 'disabled'}`,
    `Auth bootstrap enabled: ${result.authBootstrapEnabled ? 'yes' : 'no'}`,
    `OPENCODE_ZEN_API_KEY present: ${result.zenApiKeyPresent ? 'yes' : 'no'}`,
    `Auth provider: ${result.authProvider}`,
    `Auth file: ${result.authFile}`,
    `Auth file exists: ${result.authFileExists ? 'yes' : 'no'}`,
    `Auth provider exists: ${result.authProviderExists ? 'yes' : 'no'}`,
    `run --help: ${result.runHelpOk ? 'ok' : 'failed'}`,
    existingConfigs.length > 0
      ? `Config files: ${existingConfigs.map((config) => config.path).join(', ')}`
      : 'Config files: none found',
  ].filter(Boolean);

  if (result.templateWarnings.length > 0) {
    lines.push('', 'Template warnings:', ...result.templateWarnings.map((warning) => `- ${warning}`));
  }

  if (result.dangerousSkipPermissions) {
    lines.push('', 'Dangerous skip permissions warning:', '- Enabled. Use only in trusted dev/isolated environments.');
  }

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.suggestions.length > 0) {
    lines.push('', 'Suggestions:', ...result.suggestions.map((suggestion) => `- ${suggestion}`));
  }

  if (result.smokeTest) {
    lines.push(
      '',
      `Smoke test: ${result.smokeTest.ok ? 'ok' : 'failed'}`,
      result.smokeTest.summary
    );
    if (result.smokeTest.stderr) {
      lines.push('', 'Smoke stderr:', result.smokeTest.stderr.slice(0, 2000));
    }
  }

  return lines.join('\n');
}

function formatMcpAgentResult(result: McpAgentActionResult): string {
  const heading = result.action === 'listed'
    ? 'Konfigurasi MCP berhasil dibaca.'
    : result.action === 'removed'
    ? `Server MCP \`${result.serverName ?? ''}\` berhasil dihapus.`
    : result.action === 'unchanged'
    ? result.message
    : `Server MCP \`${result.serverName ?? ''}\` berhasil ${result.action === 'created' ? 'ditambahkan' : 'diperbarui'}.`;
  return [
    heading,
    '',
    `File: \`${result.configPath}\``,
    '',
    '```yaml',
    result.yamlPreview.trimEnd(),
    '```',
  ].join('\n');
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

function handleListSkills(ctx: ActionContext): string {
  const all = ctx.skillRegistry.all();
  if (all.length === 0) {
    return '📭 No skills loaded. Add .md files to the skills/ directory and restart.';
  }
  const activeIds = new Set(ctx.skillRegistry.activeIds);
  const lines = all.map((s) => {
    const marker = activeIds.has(s.id) ? '✅' : '⬜';
    const desc = s.description ? ` — ${s.description}` : '';
    return `${marker} **${s.name}** (\`${s.id}\`)${desc}`;
  });
  return ['📋 **Available Skills:**', '', ...lines].join('\n');
}

async function handleUseSkill(id: string, ctx: ActionContext): Promise<string> {
  if (!ctx.skillRegistry.has(id)) {
    return `❌ Skill \`${id}\` not found. Type "list skills" to see available skills.`;
  }
  ctx.skillRegistry.activate(id);
  const skill = ctx.skillRegistry.get(id)!;
  logger.info('skill activated via action', { id });
  return `✅ Skill **${skill.name}** activated. It will be applied to all future messages.`;
}

async function handleInstallSkill(id: string, ctx: ActionContext): Promise<string> {
  // If already in registry, just activate
  if (ctx.skillRegistry.has(id)) {
    return handleUseSkill(id, ctx);
  }

  // Try to load from skills directory
  const mdPath = join(ctx.skillsDir, `${id}.md`);
  const result = await loadSkillFromFile(mdPath);
  if (!result.ok) {
    return `❌ Could not load skill \`${id}\`: file not found at \`${mdPath}\`.\nMake sure the file exists as \`skills/${id}.md\`.`;
  }

  ctx.skillRegistry.register(result.value);
  ctx.skillRegistry.activate(id);
  logger.info('skill installed and activated via action', { id });
  return `✅ Skill **${result.value.name}** loaded and activated.`;
}

function handleDisableSkill(id: string, ctx: ActionContext): string {
  if (!ctx.skillRegistry.has(id)) {
    return `❌ Skill \`${id}\` not found.`;
  }
  ctx.skillRegistry.deactivate(id);
  const skill = ctx.skillRegistry.get(id)!;
  logger.info('skill deactivated via action', { id });
  return `⬜ Skill **${skill.name}** deactivated.`;
}

async function handleDeleteSession(idPrefix: string, ctx: ActionContext): Promise<string> {
  const result = await ctx.sessions.deleteSession(idPrefix);
  if (!result.ok) {
    return `❌ Error deleting session: ${result.error.message}`;
  }
  if (!result.value) {
    return `❌ No session found matching \`${idPrefix}\`.`;
  }
  const deletedId = result.value;

  // If the deleted session was active, clear it
  if (ctx.activeSessionId && deletedId === ctx.activeSessionId) {
    ctx.onSessionCleared();
    return `🗑️ Session \`${deletedId.slice(0, 8)}…\` deleted. Started a new session.`;
  }
  return `🗑️ Session \`${deletedId.slice(0, 8)}…\` deleted.`;
}

function normalizeMcpName(input: string): string {
  const lower = input.trim().toLowerCase();
  if (lower.includes('console')) return 'console';
  if (lower.includes('tavily')) return 'tavily';
  if (lower.includes('firecrawl')) return 'firecrawl';
  if (lower.includes('e2b')) return 'e2b';
  if (lower.includes('brevo')) return 'brevo';
  return lower.replace(/^server\s+/, '').replace(/\s+/g, '-');
}

async function handleAddMcp(nameInput: string, ctx: ActionContext): Promise<string> {
  if (!ctx.mcpManager) {
    return 'MCP is disabled or not initialized. Set MCP_ENABLED=true and restart.';
  }

  const name = normalizeMcpName(nameInput);
  await ctx.mcpManager.addServerFromInput(name);
  logger.info('MCP server added via action', { name });
  return `MCP server \`${name}\` added. Run \`/mcp start ${name}\` to start it and register its tools.`;
}

async function handleAddMcpConfig(rawJson: string, ctx: ActionContext): Promise<string> {
  if (!ctx.mcpManager) {
    return 'MCP is disabled or not initialized. Set MCP_ENABLED=true and restart.';
  }

  const config = validateMcpConfigFile(JSON.parse(rawJson));
  const names = Object.keys(config.mcpServers);
  if (names.length === 0) return 'No MCP servers found in that config.';

  for (const name of names) {
    await ctx.mcpManager.addServer(name, config.mcpServers[name]!);
  }

  logger.info('MCP config added via action', { servers: names });
  return `Added MCP server(s): ${names.map((name) => `\`${name}\``).join(', ')}. Use \`/mcp start <name>\` to start one.`;
}

function formatWorkspaceEntries(entries: Array<{ path: string; type: 'file' | 'directory' }>): string {
  if (entries.length === 0) return '(empty)';
  return entries.map((entry) => `${entry.type === 'directory' ? '[dir] ' : '[file]'} ${entry.path}`).join('\n');
}

async function handleWorkspaceAction(trimmed: string): Promise<ActionResult> {
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();

  if (WORKSPACE_LIST.test(trimmed)) {
    const entries = await workspace.list('.');
    return { handled: true, response: formatWorkspaceEntries(entries) };
  }

  if (WORKSPACE_BACKUP.test(trimmed)) {
    const backupPath = await workspace.backup();
    await workspace.appendDailyMemory({
      type: 'system_event',
      summary: `Workspace backup created: ${backupPath}`,
      source: 'chat',
    });
    return { handled: true, response: `Backup workspace dibuat: ${backupPath}` };
  }

  const readMatch = WORKSPACE_READ.exec(trimmed);
  if (readMatch?.[1]) {
    const path = readMatch[1].trim();
    return { handled: true, response: await workspace.read(path) };
  }

  const mkdirMatch = WORKSPACE_MKDIR.exec(trimmed);
  if (mkdirMatch?.[1]) {
    const path = mkdirMatch[1].trim();
    await workspace.mkdir(path);
    return { handled: true, response: `Folder workspace dibuat: ${path}` };
  }

  const memoryMatch = MEMORY_NOTE.exec(trimmed);
  if (memoryMatch?.[1]) {
    const text = memoryMatch[1].trim();
    await workspace.appendLongTermMemory(text);
    await workspace.appendDailyMemory({
      type: 'user_preference',
      summary: text,
      source: 'chat',
      details: 'User explicitly asked to store this as workspace memory.',
    });
    return { handled: true, response: 'Sudah saya catat ke workspace/MEMORY.md.' };
  }

  const userMatch = USER_UPDATE.exec(trimmed);
  if (userMatch?.[1]) {
    const text = userMatch[1].trim();
    await workspace.append('USER.md', `- ${text}`);
    await workspace.appendDailyMemory({
      type: 'user_preference',
      summary: text,
      source: 'chat',
      details: 'User profile updated in USER.md.',
    });
    return { handled: true, response: 'USER.md sudah diperbarui.' };
  }

  const writeMatch = WORKSPACE_WRITE.exec(trimmed);
  if (writeMatch?.[1] && writeMatch[2]) {
    const path = writeMatch[1].trim();
    const content = writeMatch[2].trim();
    await workspace.write(path, content);
    return { handled: true, response: `File workspace dibuat: ${path}` };
  }

  const writeWithoutContentMatch = WORKSPACE_WRITE_WITHOUT_CONTENT.exec(trimmed);
  if (writeWithoutContentMatch?.[1]) {
    const path = writeWithoutContentMatch[1].trim();
    workspace.resolvePath(path);
    return { handled: true, response: 'Sebutkan isi file yang ingin ditulis.' };
  }

  const reportMatch = REPORT_SAVE.exec(trimmed);
  if (reportMatch?.[1]) {
    const path = reportMatch[1].trim();
    const content = [
      '# Laporan Singkat',
      '',
      `Dibuat: ${new Date().toISOString()}`,
      '',
      trimmed,
      '',
    ].join('\n');
    await workspace.write(path, content);
    return { handled: true, response: `Laporan disimpan di workspace/${path}.` };
  }

  return { handled: false };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Try to handle the user input as an internal action.
 * Returns { handled: false } if no pattern matches → caller should use LLM.
 */
export async function handleAction(
  input: string,
  ctx: ActionContext,
  compiledPrompt?: CompiledPrompt
): Promise<ActionResult> {
  const trimmed = input.trim();
  const originalInput = compiledPrompt?.originalInput.trim() || trimmed;

  const approveMatch = APPROVE_COMMAND.exec(trimmed);
  if (approveMatch?.[1]) {
    const result = await approveCommand(approveMatch[1]);
    return { handled: true, response: result.content, actionType: 'command' };
  }

  const rejectMatch = REJECT_COMMAND.exec(trimmed);
  if (rejectMatch?.[1]) {
    const result = await rejectCommand(rejectMatch[1]);
    return { handled: true, response: result.content, actionType: 'command' };
  }

  const approveOpenCodeMatch = APPROVE_OPENCODE_INSTALL.exec(trimmed);
  if (approveOpenCodeMatch?.[1]) {
    const result = await approveOpenCodeInstall(approveOpenCodeMatch[1]);
    return { handled: true, response: formatOpenCodeInstallResult(result), actionType: 'command' };
  }

  const rejectOpenCodeMatch = REJECT_OPENCODE_INSTALL.exec(trimmed);
  if (rejectOpenCodeMatch?.[1]) {
    const result = await rejectOpenCodeInstall(rejectOpenCodeMatch[1]);
    return { handled: true, response: formatOpenCodeInstallResult(result), actionType: 'command' };
  }

  const opencodeDoctorMatch = OPENCODE_DOCTOR.exec(trimmed);
  if (opencodeDoctorMatch) {
    const result = await runOpenCodeDoctor({ smokeTest: Boolean(opencodeDoctorMatch[1]) });
    return { handled: true, response: formatOpenCodeDoctorResult(result), actionType: 'command' };
  }

  const isCompiledMcpConfiguration =
    compiledPrompt?.intent === 'mcp-config-update' ||
    compiledPrompt?.intent === 'mcp-config-read' ||
    compiledPrompt?.routingHint === 'self-configuration';
  const mcpCapability = capabilityForIntent(compiledPrompt?.intent ?? '', originalInput);
  if (mcpCapability?.startsWith('mcp.') && ctx.agentGateway) {
    const result = await ctx.agentGateway.execute({
      id: createAgentTaskId('mcp'),
      intent: compiledPrompt?.intent ?? 'mcp',
      capability: mcpCapability,
      userInput: originalInput,
      cwd: process.cwd(),
    });
    return {
      handled: true,
      response: result.ok
        ? result.output ?? result.summary
        : `MCP Agent failed: ${result.error?.message ?? result.summary}`,
      actionType: 'self_configuration',
    };
  }
  if (isCompiledMcpConfiguration || isMcpConfigurationIntent(originalInput)) {
    if (!ctx.mcpAgent?.enabled) {
      return {
        handled: true,
        response: 'MCP Agent self-configuration is disabled. Set MCP_AGENT_ENABLED=true.',
        actionType: 'self_configuration',
      };
    }
    try {
      const result = await ctx.mcpAgent.handleInstruction(originalInput);
      return {
        handled: true,
        response: formatMcpAgentResult(result),
        actionType: 'self_configuration',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('MCP self-configuration failed', { error: message });
      return {
        handled: true,
        response: [
          'Gagal memperbarui konfigurasi MCP.',
          `Reason: ${message}`,
          '',
          'No file changes were saved.',
        ].join('\n'),
        actionType: 'self_configuration',
      };
    }
  }

  const infoCapabilityQuestion =
    isInformationalCapabilityQuestion(originalInput) || isInformationalCapabilityQuestion(trimmed);
  if (
    infoCapabilityQuestion &&
    (compiledPrompt?.intent === 'self-upgrade' || compiledPrompt?.intent === 'self-healing')
  ) {
    return {
      handled: true,
      response: capabilityExplanationResponse(),
      actionType: 'other',
    };
  }

  if (compiledPrompt?.intent === 'self-upgrade') {
    if (!ctx.selfHealing) {
      return {
        handled: true,
        response: 'Self-upgrade is disabled. Set SELF_UPGRADE_ENABLED=true.',
        actionType: 'self_upgrade',
      };
    }
    const upgradeAction = await handleSelfHealingAction(
      `/upgrade run ${compiledPrompt.optimizedInput}`,
      ctx.selfHealing,
      'system'
    );
    return {
      handled: true,
      response: upgradeAction.response ?? 'Self-upgrade is disabled. Set SELF_UPGRADE_ENABLED=true.',
      actionType: 'self_upgrade',
    };
  }

  if (compiledPrompt?.intent === 'self-healing') {
    const selfHealingEnabled = ctx.selfHealing?.healingEnabled === true && Boolean(ctx.selfHealing.healingEngine);
    if (selfHealingEnabled && ctx.selfHealing) {
      const healingAction = await handleSelfHealingAction(
        `/heal run ${compiledPrompt.optimizedInput}`,
        ctx.selfHealing,
        'system'
      );
      return {
        handled: true,
        response: healingAction.response ?? '',
        actionType: 'self_healing',
      };
    }
    if (isApplicationDebugRequest(originalInput)) {
      return {
        handled: true,
        response: applicationDebugDiagnostic(selfHealingEnabled),
        actionType: 'other',
      };
    }
    return {
      handled: true,
      response: 'Self-healing is disabled. Set SELF_HEALING_ENABLED=true.',
      actionType: 'self_healing',
    };
  }

  if (ctx.selfImproving) {
    const selfImprovingAction = await handleSelfImprovingAction(trimmed, ctx.selfImproving);
    if (selfImprovingAction.handled) {
      return {
        handled: true,
        response: selfImprovingAction.response ?? '',
        actionType: 'self_improve',
      };
    }
  }

  if (ctx.selfHealing) {
    const selfHealingAction = await handleSelfHealingAction(trimmed, ctx.selfHealing, 'system');
    if (selfHealingAction.handled) {
      const isUpgrade = isSelfUpgradeIntent(trimmed);
      return {
        handled: true,
        response: selfHealingAction.response ?? '',
        actionType: isUpgrade ? 'self_upgrade' : 'self_healing',
      };
    }
  }

  if (isApplicationDebugRequest(trimmed)) {
    const selfHealingEnabled = ctx.selfHealing?.healingEnabled === true && Boolean(ctx.selfHealing.healingEngine);
    if (selfHealingEnabled && isApplicationDebugFixRequest(trimmed) && ctx.selfHealing) {
      const healingAction = await handleSelfHealingAction(
        `/heal run ${telegramPollingLogFixInstruction()}`,
        ctx.selfHealing,
        'system'
      );
      return {
        handled: true,
        response: [
          'Self-healing run started: fix Telegram polling log suppression.',
          healingAction.response ?? '',
        ].filter(Boolean).join('\n\n'),
        actionType: 'self_healing',
      };
    }

    return {
      handled: true,
      response: applicationDebugDiagnostic(selfHealingEnabled),
      actionType: 'other',
    };
  }

  if (ctx.scheduler) {
    const schedulerInput = compiledPrompt?.intent === 'scheduler' ? originalInput : trimmed;
    const schedulerAction = await handleSchedulerText(schedulerInput, ctx.scheduler, 'system');
    if (schedulerAction.handled) return schedulerAction;
  }

  try {
    const workspaceAction = await handleWorkspaceAction(trimmed);
    if (workspaceAction.handled) return workspaceAction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handled: true, response: `Workspace error: ${msg}` };
  }

  // list skills
  if (LIST_SKILLS.test(trimmed)) {
    logger.debug('action: list skills');
    return { handled: true, response: handleListSkills(ctx) };
  }

  // use/activate/enable skill <id>
  const useMatch = USE_SKILL.exec(trimmed);
  if (useMatch?.[1]) {
    const id = useMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    logger.debug('action: use skill', { id });
    return { handled: true, response: await handleUseSkill(id, ctx) };
  }

  // install skill <id>
  const installMatch = INSTALL_SKILL.exec(trimmed);
  if (installMatch?.[1]) {
    const id = installMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    logger.debug('action: install skill', { id });
    return { handled: true, response: await handleInstallSkill(id, ctx) };
  }

  // disable/deactivate/remove skill <id>
  const disableMatch = DISABLE_SKILL.exec(trimmed);
  if (disableMatch?.[1]) {
    const id = disableMatch[1].trim().toLowerCase().replace(/\s+/g, '-');
    logger.debug('action: disable skill', { id });
    return { handled: true, response: handleDisableSkill(id, ctx) };
  }

  // delete session <id>
  const deleteMatch = DELETE_SESSION.exec(trimmed);
  if (deleteMatch?.[1]) {
    const idPrefix = deleteMatch[1].trim();
    logger.debug('action: delete session', { idPrefix });
    return { handled: true, response: await handleDeleteSession(idPrefix, ctx) };
  }

  const mcpConfigMatch = ADD_MCP_CONFIG.exec(trimmed);
  if (mcpConfigMatch?.[1]) {
    logger.debug('action: add MCP config');
    try {
      return { handled: true, response: await handleAddMcpConfig(mcpConfigMatch[1], ctx) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: true, response: `Could not add MCP config: ${msg}` };
    }
  }

  const mcpMatch = ADD_MCP.exec(trimmed);
  if (mcpMatch?.[1]) {
    logger.debug('action: add MCP', { input: mcpMatch[1] });
    try {
      return { handled: true, response: await handleAddMcp(mcpMatch[1], ctx) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { handled: true, response: `Could not add MCP server: ${msg}` };
    }
  }

  return { handled: false };
}
