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
import { loadSkillFromFile } from '../skills/loader';
import { join } from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('agent:action-handler');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ActionContext {
  skillRegistry: SkillRegistry;
  sessions: SessionManager;
  /** Absolute path to the skills directory. */
  skillsDir: string;
  /** Currently active session ID (may be null). */
  activeSessionId: string | null;
  /** Called when the active session must be cleared (e.g. after delete). */
  onSessionCleared: () => void;
}

export interface ActionResult {
  /** true = action was handled; false = pass to LLM */
  handled: boolean;
  /** Text response to display to the user (when handled = true). */
  response?: string;
}

// ─── Pattern matchers ─────────────────────────────────────────────────────────

const LIST_SKILLS    = /^list\s+skills?$/i;
const USE_SKILL      = /^(?:use|activate|enable)\s+skill\s+(.+)$/i;
const INSTALL_SKILL  = /^install\s+skill\s+(.+)$/i;
const DISABLE_SKILL  = /^(?:disable|deactivate|remove)\s+skill\s+(.+)$/i;
const DELETE_SESSION = /^delete\s+session\s+([a-f0-9-]{4,36})$/i;

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

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Try to handle the user input as an internal action.
 * Returns { handled: false } if no pattern matches → caller should use LLM.
 */
export async function handleAction(
  input: string,
  ctx: ActionContext
): Promise<ActionResult> {
  const trimmed = input.trim();

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

  return { handled: false };
}
