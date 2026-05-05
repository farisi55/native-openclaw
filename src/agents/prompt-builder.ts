/**
 * agents/prompt-builder.ts
 * Assemble the final system prompt from:
 *   1. MEMORY block  (persistent facts — highest priority)
 *   2. SYSTEM CONTEXT block (provider, model, skills awareness)
 *   3. Base system prompt
 *   4. Active skill blocks
 */

import type { Skill } from '../skills/loader';
import { getSystemContext, type SystemContextInput } from './system-context';

export interface PromptBuilderOptions {
  basePrompt: string;
  skills: Skill[];
  maxSkillBodyLength?: number;
  /** Auto-generated system context (provider, model, skills list). */
  systemContext?: SystemContextInput;
  /**
   * Pre-rendered MEMORY block string from MemoryManager.buildMemoryBlock().
   * When provided, it is injected FIRST in the system prompt so the LLM
   * always honours stored facts (like agent name) over its defaults.
   */
  memoryBlock?: string | null;
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
  private readonly opts: Required<Omit<PromptBuilderOptions, 'systemContext' | 'memoryBlock'>> & {
    systemContext?: SystemContextInput;
    memoryBlock?: string | null;
  };

  constructor(opts: PromptBuilderOptions) {
    this.opts = { maxSkillBodyLength: 4000, ...opts };
  }

  build(): string {
    const { basePrompt, skills, maxSkillBodyLength, systemContext, memoryBlock } = this.opts;

    const parts: string[] = [];

    // 1. MEMORY — injected FIRST so facts always override LLM defaults
    if (memoryBlock) {
      parts.push(memoryBlock.trim());
    }

    // 2. System context (self-awareness: provider, model, skills)
    if (systemContext) {
      parts.push(getSystemContext(systemContext));
    }

    // 3. Base system prompt
    parts.push(basePrompt.trim());

    // 4. Active skill blocks
    if (skills.length > 0) {
      const blocks = skills.map((s) => renderSkillBlock(s, maxSkillBodyLength));
      const skillSection = ['## Active Skills', '', blocks.join('\n\n---\n\n')].join('\n');
      parts.push(skillSection);
    }

    return parts.join('\n\n');
  }

  summary(): {
    baseLength: number;
    skillCount: number;
    skillIds: string[];
    hasContext: boolean;
    hasMemory: boolean;
  } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds: this.opts.skills.map((s) => s.id),
      hasContext: Boolean(this.opts.systemContext),
      hasMemory: Boolean(this.opts.memoryBlock),
    };
  }
}

export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
