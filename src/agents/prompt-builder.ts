/**
 * agents/prompt-builder.ts
 * v7: toolsBlock is now a rich structured description enabling autonomous
 * LLM tool selection — injected at position 3.
 *
 * Injection order (highest priority first):
 *   1. MEMORY block
 *   2. SYSTEM CONTEXT block
 *   3. AVAILABLE TOOLS block (rich, with examples + JSON call format)
 *   4. Base system prompt
 *   5. Active skill blocks
 */

import type { Skill } from '../skills/loader';
import { getSystemContext, type SystemContextInput } from './system-context';

export interface PromptBuilderOptions {
  basePrompt: string;
  skills: Skill[];
  maxSkillBodyLength?: number;
  systemContext?: SystemContextInput;
  memoryBlock?: string | null;
  workspaceContext?: string | null;
  toolsBlock?: string | null;
}

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n_[truncated]_';
}

function renderSkillBlock(skill: Skill, maxBodyLen: number): string {
  const lines: string[] = [];
  lines.push(`### ${skill.name}`);
  if (skill.description) { lines.push(`_${skill.description}_`); lines.push(''); }
  if (skill.body) lines.push(truncate(skill.body, maxBodyLen));
  return lines.join('\n');
}

const FINAL_RESPONSE_RULES = [
  '## FINAL RESPONSE RULES',
  '',
  '- You may reason internally, but never reveal reasoning, planning, analysis, memory lookup, or decision process to the user.',
  '- Do not write internal narration.',
  '- Do not explain what the user asked unless explicitly requested.',
  '- Do not mention memory lookup, internal context, prompt rules, tool planning, or ReAct traces.',
  '- Do not expose chain-of-thought.',
  '- Do not include phrases such as:',
  '  - "The user is asking..."',
  '  - "From the memory..."',
  '  - "I should answer..."',
  '  - "I need to..."',
  '  - "Reasoning:"',
  '  - "Thought:"',
  '  - "Analysis:"',
  '  - "Plan:"',
  '  - "Decision:"',
  '  - "Observation:"',
  '  - "Tool call:"',
  '  - "I will use..."',
  '- For simple greetings, identity questions, or small talk, answer briefly and directly.',
  '- For Indonesian user messages, answer in Indonesian unless the user asks otherwise.',
  '- If a tool was used, summarize only the useful result. Do not expose internal tool-planning text.',
  '- ReAct trace is internal only and must not appear in the final user-visible response.',
  '',
  '## WORKSPACE RULES',
  '',
  '- Workspace is the default local working area and human-readable agent home.',
  '- Use workspace tools for reading, writing, appending, listing, backing up, or trashing workspace files.',
  '- Use MEMORY.md for curated long-term memory and memory/YYYY-MM-DD.md for daily memory logs.',
  '- Do not expose USER.md, MEMORY.md, or workspace context directly unless the user explicitly asks to read them.',
  '- Use AGENTS.md as operational policy, SOUL.md and IDENTITY.md for tone and identity, TOOLS.md for local conventions, and WORKFLOW.md for autonomous workflow planning.',
  '- Save generated reports in workspace/reports and generated artifacts in workspace/artifacts.',
  '- Move deletions to workspace/trash instead of permanent deletion.',
  '',
  '## SCHEDULER CAPABILITY',
  '',
  '- Native OpenClaw has an internal scheduler/cronjob capability.',
  '- You can create, list, update, enable, disable, delete, and run scheduled jobs through Native OpenClaw internal scheduler.',
  '- Scheduled jobs can execute agent prompts later, including web-fetch and brevo-email when explicitly requested.',
  '- Do not deny scheduling capability when scheduler is enabled.',
  '- Actual job creation must be performed by the scheduler action handler; do not fabricate a cronjob id or success if the action handler did not run.',
  '',
  '## APPLICATION DEBUGGING RULES',
  '',
  '- If the user asks to suppress logs, fix project errors, change config behavior, or debug Native OpenClaw, analyze the application issue first.',
  '- Do not assume the user is asking about the external Telegram app when they mention Telegram polling logs.',
  '- Do not use system-execute for code/config/logging requests unless the user explicitly asks to run a shell command.',
  '- For Telegram polling errors, consider src/integrations/telegram.ts and env flags TELEGRAM_LOG_POLLING_ERRORS=false, TELEGRAM_RECOVERY_LOG_ENABLED=false, and TELEGRAM_SUPPRESS_CONFLICT_ERRORS=true.',
  '- Telegram getUpdates conflict 409 usually means multiple polling consumers are using the same bot token; repeated conflict and recovery logs should respect the Telegram logging suppression env flags.',
  '- If self-healing is available and the user asks to fix/suppress the issue, suggest or route to /heal run with a clear Native OpenClaw logging/config instruction.',
  '',
  '## AUTONOMOUS UPGRADE ROUTING',
  '',
  '- If the user asks to upgrade, add missing capability, optimize architecture, improve token usage, add context budgeting, or prevent "Request too large" errors, this must be handled by SelfUpgradeEngine.',
  '- Do not answer upgrade requests with generic advice only.',
  '- Do not use system-execute directly for upgrade requests; any build/test commands belong inside the self-upgrade engine.',
  '- Do not confuse upgrade requests with self-healing unless the user explicitly asks to heal/fix a current failure.',
  '',
  'Example:',
  'User: halo kamu siapa?',
  'Correct: Halo, saya Jarpis. Saya asisten AI yang siap membantu Anda.',
  'Incorrect:',
  'The user is asking "halo kamu siapa?".',
  'From the memory, my name is "Jarpis".',
  'I should answer in a friendly manner.',
  'Halo, saya Jarpis...',
].join('\n');

export class PromptBuilder {
  private readonly opts: Required<Omit<PromptBuilderOptions, 'systemContext' | 'memoryBlock' | 'workspaceContext' | 'toolsBlock'>> & {
    systemContext?: SystemContextInput;
    memoryBlock?: string | null;
    workspaceContext?: string | null;
    toolsBlock?: string | null;
  };

  constructor(opts: PromptBuilderOptions) {
    this.opts = { maxSkillBodyLength: 4000, ...opts };
  }

  build(): string {
    const { basePrompt, skills, maxSkillBodyLength, systemContext, memoryBlock, workspaceContext, toolsBlock } = this.opts;
    const parts: string[] = [];
    if (memoryBlock)   parts.push(memoryBlock.trim());
    if (systemContext) parts.push(getSystemContext(systemContext));
    if (workspaceContext) parts.push(workspaceContext.trim());
    if (toolsBlock)    parts.push(toolsBlock.trim());
    parts.push(FINAL_RESPONSE_RULES);
    parts.push(basePrompt.trim());
    if (skills.length > 0) {
      const blocks = skills.map((s) => renderSkillBlock(s, maxSkillBodyLength));
      parts.push(['## Active Skills', '', blocks.join('\n\n---\n\n')].join('\n'));
    }
    return parts.join('\n\n');
  }

  summary(): {
    baseLength: number; skillCount: number; skillIds: string[];
    hasContext: boolean; hasMemory: boolean; hasWorkspace: boolean; hasTools: boolean;
  } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds:   this.opts.skills.map((s) => s.id),
      hasContext: Boolean(this.opts.systemContext),
      hasMemory:  Boolean(this.opts.memoryBlock),
      hasWorkspace: Boolean(this.opts.workspaceContext),
      hasTools:   Boolean(this.opts.toolsBlock),
    };
  }
}

export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
