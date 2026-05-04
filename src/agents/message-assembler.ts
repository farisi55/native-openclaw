/**
 * agents/message-assembler.ts
 * Prepares a provider-ready message array from session history.
 *
 * Rules applied in order:
 *  1. Strip system messages (injected separately via systemPrompt param).
 *  2. Apply a sliding window (keep last N messages).
 *  3. Ensure the first message is always from role=user.
 *  4. Optional character-budget trim.
 */

import type { Message } from '../types/message';
import { extractText } from '../types/message';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AssembleOptions {
  messages: Message[];
  /**
   * Maximum messages to keep.
   * 0 = no limit.  Default: 40.
   */
  maxMessages?: number;
  /**
   * Character budget across all content.
   * 0 = no budget check.  Default: 0.
   */
  charBudget?: number;
}

export interface AssembledMessages {
  messages: Message[];
  /** Rough character count of assembled content. */
  estimatedChars: number;
  /** Messages dropped from the original history. */
  dropped: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Very rough token estimate: 1 token ≈ 4 chars. */
export function roughTokenEstimate(chars: number): number {
  return Math.ceil(chars / 4);
}

function msgChars(msg: Message): number {
  return extractText(msg.content).length;
}

// ─── MessageAssembler ─────────────────────────────────────────────────────────

export class MessageAssembler {
  private readonly maxMessages: number;
  private readonly charBudget: number;

  constructor(opts: Pick<AssembleOptions, 'maxMessages' | 'charBudget'> = {}) {
    this.maxMessages = opts.maxMessages ?? 40;
    this.charBudget = opts.charBudget ?? 0;
  }

  assemble(messages: Message[]): AssembledMessages {
    // 1. Strip system messages.
    const nonSystem = messages.filter((m) => m.role !== 'system');
    const original = nonSystem.length;

    // 2. Sliding window.
    let windowed = nonSystem;
    if (this.maxMessages > 0 && windowed.length > this.maxMessages) {
      windowed = windowed.slice(-this.maxMessages);
    }

    // 3. Ensure starts with user.
    while (windowed.length > 0 && windowed[0]?.role !== 'user') {
      windowed = windowed.slice(1);
    }

    // 4. Optional char-budget trim from the oldest end.
    if (this.charBudget > 0) {
      let total = windowed.reduce((acc, m) => acc + msgChars(m), 0);
      while (windowed.length > 1 && total > this.charBudget) {
        const removed = windowed.shift();
        if (removed) total -= msgChars(removed);
        while (windowed.length > 0 && windowed[0]?.role !== 'user') {
          windowed.shift();
        }
      }
    }

    return {
      messages: windowed,
      estimatedChars: windowed.reduce((acc, m) => acc + msgChars(m), 0),
      dropped: original - windowed.length,
    };
  }
}

/** Functional convenience wrapper. */
export function assembleMessages(opts: AssembleOptions): AssembledMessages {
  const asmOpts: Pick<AssembleOptions, "maxMessages" | "charBudget"> = {};
  if (opts.maxMessages !== undefined) asmOpts.maxMessages = opts.maxMessages;
  if (opts.charBudget !== undefined) asmOpts.charBudget = opts.charBudget;
  return new MessageAssembler(asmOpts).assemble(opts.messages);
}
