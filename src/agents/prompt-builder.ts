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
    if (memoryBlock)   parts.push(memoryBlock.trim());
    if (systemContext) parts.push(getSystemContext(systemContext));
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
    hasContext: boolean; hasMemory: boolean; hasTools: boolean;
  } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds:   this.opts.skills.map((s) => s.id),
      hasContext: Boolean(this.opts.systemContext),
      hasMemory:  Boolean(this.opts.memoryBlock),
      hasTools:   Boolean(this.opts.toolsBlock),
    };
  }
}

export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
