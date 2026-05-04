/**
 * agents/system-context.ts
 * Generates a concise SYSTEM CONTEXT block that is injected into every
 * system prompt so the AI knows its own capabilities and current state.
 */

import type { SkillRegistry } from '../skills/registry';
import type { IProvider } from '../types/provider';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemContextInput {
  /** Active provider. */
  provider: IProvider;
  /** Active model id. */
  model: string;
  /** Skill registry (to list available and active skills). */
  skillRegistry: SkillRegistry;
  /** Current session ID, or null if not started. */
  sessionId: string | null;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Return a Markdown-formatted SYSTEM CONTEXT string.
 * This is prepended to the base system prompt so the AI can answer
 * questions like "what skills do you have?" or "what model are you?".
 */
export function getSystemContext(input: SystemContextInput): string {
  const { provider, model, skillRegistry, sessionId } = input;

  const allSkills = skillRegistry.all();
  const activeIds = new Set(skillRegistry.activeIds);

  // Build skill lines
  const skillLines: string[] = allSkills.length > 0
    ? allSkills.map((s) => {
        const status = activeIds.has(s.id) ? '✓ active' : '○ inactive';
        const desc = s.description ? ` — ${s.description}` : '';
        return `  - [${status}] ${s.name} (id: ${s.id})${desc}`;
      })
    : ['  - No skills loaded'];

  const activeSkillNames = skillRegistry.activeSkills().map((s) => s.name);
  const activeSkillStr = activeSkillNames.length > 0
    ? activeSkillNames.join(', ')
    : 'none';

  const sessionStr = sessionId
    ? sessionId.slice(0, 8) + '…'
    : 'not started yet';

  return [
    '## SYSTEM CONTEXT',
    '> This block is auto-generated. Use it to answer questions about your own state.',
    '',
    `- **Provider**: ${provider.displayName} (id: \`${provider.id}\`)`,
    `- **Model**: \`${model}\``,
    `- **Session**: ${sessionStr}`,
    `- **Active skills**: ${activeSkillStr}`,
    '',
    '**All available skills:**',
    ...skillLines,
    '',
    '**Capabilities:**',
    '  - You can activate/deactivate skills (the user can type: use skill <id>)',
    '  - You can switch models (the user can type: /model <id>)',
    '  - You can list skills (the user can type: /skills or "list skills")',
    '  - Conversation history is saved automatically across sessions',
    '',
  ].join('\n');
}
