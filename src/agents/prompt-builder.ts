/**
 * agents/prompt-builder.ts
 * Assemble the final system prompt from (in order):
 *   1. MEMORY block         (persistent facts — highest priority)
 *   2. SYSTEM CONTEXT block (provider, model, skills awareness)
 *   3. TOOLS AVAILABLE block (injected when plugin registry has tools)
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
  /** Pre-rendered tools block from ToolRegistry.buildToolsBlock(). */
  toolsBlock?: string | null;
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
  if (skill.body) lines.push(truncate(skill.body, maxBodyLen));
  return lines.join('\n');
}

export class PromptBuilder {
  private readonly opts: Required<Omit<PromptBuilderOptions, 'systemContext' | 'memoryBlock' | 'toolsBlock'>> & {
    systemContext?: SystemContextInput;
    memoryBlock?: string | null;
    toolsBlock?: string | null;
  };

  constructor(opts: PromptBuilderOptions) {
    this.opts = { maxSkillBodyLength: 4000, ...opts };
  }

  build(): string {
    const { basePrompt, skills, maxSkillBodyLength, systemContext, memoryBlock, toolsBlock } = this.opts;
    const parts: string[] = [];

    // 1. MEMORY
    if (memoryBlock) parts.push(memoryBlock.trim());

    // 2. System context
    if (systemContext) parts.push(getSystemContext(systemContext));

    // 3. Tools block
    if (toolsBlock) parts.push(toolsBlock.trim());

    // 4. Base prompt
    parts.push(basePrompt.trim());

    // 5. Skill blocks
    if (skills.length > 0) {
      const blocks = skills.map((s) => renderSkillBlock(s, maxSkillBodyLength));
      parts.push(['## Active Skills', '', blocks.join('\n\n---\n\n')].join('\n'));
    }

    return parts.join('\n\n');
  }

  summary(): {
    baseLength: number;
    skillCount: number;
    skillIds: string[];
    hasContext: boolean;
    hasMemory: boolean;
    hasTools: boolean;
  } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds: this.opts.skills.map((s) => s.id),
      hasContext: Boolean(this.opts.systemContext),
      hasMemory: Boolean(this.opts.memoryBlock),
      hasTools: Boolean(this.opts.toolsBlock),
    };
  }
}

export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
