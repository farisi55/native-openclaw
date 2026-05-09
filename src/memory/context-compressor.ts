/**
 * memory/context-compressor.ts
 * Reduces token usage by replacing full history with:
 *   - Recent N messages (sliding window)
 *   - Retrieved semantic memories (relevant past context)
 *   - Optional summary injection
 *
 * Result: LLM sees a focused, token-efficient context window.
 */

import type { Message } from '../types/message';
import { createMessage } from '../types/message';
import type { SemanticMemory } from './semantic-memory';
import { createLogger } from '../utils/logger';

const logger = createLogger('memory:compressor');

export interface CompressionOptions {
  /** Keep this many most-recent messages verbatim. Default: 8. */
  recentWindowSize?: number;
  /** How many semantic memory chunks to inject. Default: 4. */
  semanticTopK?: number;
  /** Max age (days) for semantic retrieval. Default: 7. */
  maxMemoryAgeDays?: number;
}

export interface CompressedContext {
  messages: Message[];
  /** Total messages in the original history. */
  originalCount: number;
  /** Messages in the compressed result. */
  compressedCount: number;
  /** Number of semantic chunks injected. */
  memoriesInjected: number;
}

export class ContextCompressor {
  private readonly semanticMemory: SemanticMemory;
  private readonly defaults: Required<CompressionOptions>;

  constructor(semanticMemory: SemanticMemory, opts: CompressionOptions = {}) {
    this.semanticMemory = semanticMemory;
    this.defaults = {
      recentWindowSize: opts.recentWindowSize ?? 8,
      semanticTopK:     opts.semanticTopK     ?? 4,
      maxMemoryAgeDays: opts.maxMemoryAgeDays ?? 7,
    };
  }

  /**
   * Compress the message history for a single turn.
   *
   * @param messages    - Full session history (all messages).
   * @param userInput   - Current user query (used for semantic search).
   * @param sessionId   - Session ID for same-session boosting.
   */
  compress(
    messages: Message[],
    userInput: string,
    sessionId: string,
    opts: CompressionOptions = {}
  ): CompressedContext {
    const cfg = { ...this.defaults, ...opts };
    const originalCount = messages.length;

    // Strip system messages (handled by system prompt)
    const nonSystem = messages.filter((m) => m.role !== 'system');

    // If history is short enough, skip compression
    if (nonSystem.length <= cfg.recentWindowSize) {
      return {
        messages: nonSystem,
        originalCount,
        compressedCount: nonSystem.length,
        memoriesInjected: 0,
      };
    }

    // Keep only the most recent N messages
    const recentMessages = nonSystem.slice(-cfg.recentWindowSize);

    // Retrieve relevant memories from further back
    const memories = this.semanticMemory.retrieve(
      userInput,
      cfg.semanticTopK,
      sessionId,
      cfg.maxMemoryAgeDays
    );

    // Deduplicate: skip memory chunks that are already in recentMessages
    const recentIds = new Set(recentMessages.map((m) => m.id));
    const relevantMemories = memories.filter((r) => !recentIds.has(r.chunk.id));

    if (relevantMemories.length === 0) {
      return {
        messages: recentMessages,
        originalCount,
        compressedCount: recentMessages.length,
        memoriesInjected: 0,
      };
    }

    // Build a memory context injection message
    const memoryLines = relevantMemories.map((r) => {
      const when = Math.round((Date.now() - r.chunk.createdAt) / 60_000);
      const timeLabel = when < 60
        ? `${when}m ago`
        : when < 1440
        ? `${Math.round(when / 60)}h ago`
        : `${Math.round(when / 1440)}d ago`;
      return `[${r.chunk.role}, ${timeLabel}]: ${r.chunk.content.slice(0, 300)}`;
    });

    const memoryInjectionMsg = createMessage({
      role: 'user',
      content: [
        'RELEVANT CONTEXT FROM EARLIER IN OUR CONVERSATION:',
        '',
        ...memoryLines,
        '',
        '--- End of retrieved context ---',
      ].join('\n'),
    });

    const compressed = [memoryInjectionMsg, ...recentMessages];

    logger.debug('context compressed', {
      original: originalCount,
      compressed: compressed.length,
      memoriesInjected: relevantMemories.length,
      sessionId,
    });

    return {
      messages: compressed,
      originalCount,
      compressedCount: compressed.length,
      memoriesInjected: relevantMemories.length,
    };
  }

  /**
   * Store a new exchange into semantic memory.
   * Call this AFTER each turn completes.
   */
  storeExchange(
    sessionId: string,
    userInput: string,
    assistantText: string
  ): void {
    this.semanticMemory.store(sessionId, 'user', userInput, 1);
    this.semanticMemory.store(sessionId, 'assistant', assistantText, 1);
  }
}
