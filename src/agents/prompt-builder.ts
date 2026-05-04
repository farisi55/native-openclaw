/**
 * agents/prompt-builder.ts
 * Assemble the final system prompt from:
 *   1. SYSTEM CONTEXT block (provider, model, skills awareness)
 *   2. Base system prompt
 *   3. Active skill blocks
 */

import type { Skill } from '../skills/loader';
import { getSystemContext, type SystemContextInput } from './system-context';

export interface PromptBuilderOptions {
  basePrompt: string;
  skills: Skill[];
  maxSkillBodyLength?: number;
  /** When provided, prepends a SYSTEM CONTEXT block so the AI knows its state. */
  systemContext?: SystemContextInput;
}

function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0 || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\n\n_[truncated]_';
}

function renderSkillBlock(skill: Skill, maxBodyLen: number): string {
  const lines: string[] = [];
  lines.push(`### ${skill.name}`);
  if (skill.description) {
    lines.push(`_${skill.description}_`);
    lines.push('');
  }
  if (skill.body) {
    lines.push(truncate(skill.body, maxBodyLen));
  }
  return lines.join('\n');
}

export class PromptBuilder {
  private readonly opts: Required<Omit<PromptBuilderOptions, 'systemContext'>> & {
    systemContext?: SystemContextInput;
  };

  constructor(opts: PromptBuilderOptions) {
    this.opts = { maxSkillBodyLength: 4000, ...opts };
  }

  build(): string {
    const { basePrompt, skills, maxSkillBodyLength, systemContext } = this.opts;

    const parts: string[] = [];

    // 1. System context block (AI self-awareness)
    if (systemContext) {
      parts.push(getSystemContext(systemContext));
    }

    // 2. Base prompt
    parts.push(basePrompt.trim());

    // 3. Active skill blocks
    if (skills.length > 0) {
      const blocks = skills.map((s) => renderSkillBlock(s, maxSkillBodyLength));
      const skillSection = ['## Active Skills', '', blocks.join('\n\n---\n\n')].join('\n');
      parts.push(skillSection);
    }

    return parts.join('\n\n');
  }

  summary(): { baseLength: number; skillCount: number; skillIds: string[]; hasContext: boolean } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds: this.opts.skills.map((s) => s.id),
      hasContext: Boolean(this.opts.systemContext),
    };
  }
}

export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
