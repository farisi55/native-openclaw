/**
 * agents/prompt-builder.ts
 * Assemble the final system prompt from a base string plus
 * any active skill blocks.
 *
 * Rendered format:
 * ─────────────────────────────────────────────────
 * <base system prompt>
 *
 * ## Active Skills
 *
 * ### <Skill Name>
 * _<description>_
 *
 * <skill markdown body>
 *
 * ---
 * ### <Next Skill>
 * …
 * ─────────────────────────────────────────────────
 */

import type { Skill } from '../skills/loader';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptBuilderOptions {
  /** Base system prompt (from config or caller override). */
  basePrompt: string;

  /**
   * Skills to inject. Pass an empty array to skip injection.
   * Skills should already be sorted by priority.
   */
  skills: Skill[];

  /**
   * Max character length per skill body before truncation.
   * 0 = no limit.  Default: 4000.
   */
  maxSkillBodyLength?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── PromptBuilder ────────────────────────────────────────────────────────────

export class PromptBuilder {
  private readonly opts: Required<PromptBuilderOptions>;

  constructor(opts: PromptBuilderOptions) {
    this.opts = { maxSkillBodyLength: 4000, ...opts };
  }

  build(): string {
    const { basePrompt, skills, maxSkillBodyLength } = this.opts;
    if (skills.length === 0) return basePrompt.trim();

    const blocks = skills.map((s) => renderSkillBlock(s, maxSkillBodyLength));
    const skillSection = ['## Active Skills', '', blocks.join('\n\n---\n\n')].join('\n');
    return [basePrompt.trim(), '', skillSection].join('\n');
  }

  summary(): { baseLength: number; skillCount: number; skillIds: string[] } {
    return {
      baseLength: this.opts.basePrompt.length,
      skillCount: this.opts.skills.length,
      skillIds: this.opts.skills.map((s) => s.id),
    };
  }
}

/** Functional convenience wrapper. */
export function buildSystemPrompt(opts: PromptBuilderOptions): string {
  return new PromptBuilder(opts).build();
}
