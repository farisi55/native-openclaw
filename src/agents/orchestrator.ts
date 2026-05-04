/**
 * agents/orchestrator.ts
 * Main agent loop — one call per user turn.
 *
 *   user input
 *     → session loaded (or created)
 *     → active skills resolved
 *     → system prompt built
 *     → messages assembled (sliding window)
 *     → provider.chat() called
 *     → assistant message persisted
 *     → TurnResult returned to caller
 *
 * The orchestrator is stateless between calls; all state lives in
 * SessionManager (disk) and SkillRegistry (memory).
 */

import type { IProvider, ChatResponse } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { createLogger } from '../utils/logger';

const logger = createLogger('agent:orchestrator');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  /** Base system prompt (defaults to a generic helpful assistant). */
  baseSystemPrompt?: string;
  /** Max conversation turns before refusing. Default: 20. */
  maxTurns?: number;
  /** Max messages in the sliding window. Default: 40. */
  maxMessages?: number;
  /** Default temperature. Default: 0.7. */
  temperature?: number;
  /** Default maxTokens. Default: 4096. */
  maxTokens?: number;
}

export interface TurnInput {
  /** The user's message text. */
  userInput: string;
  /** Provider to use for this turn. */
  provider: IProvider;
  /** Model identifier (e.g. "llama-3.3-70b-versatile"). */
  model: string;
  /**
   * Session ID. Omit to create a new session automatically.
   * Pass the returned session.id on subsequent turns.
   */
  sessionId?: string;
  /**
   * Skill IDs to activate for this turn.
   * Overrides the registry's current active set.
   * Omit to use the registry's current active set unchanged.
   */
  skillIds?: string[];
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface TurnResult {
  chatResponse: ChatResponse;
  /** Plain text of the assistant's reply. */
  assistantText: string;
  /** Session state after this turn is persisted. */
  session: Session;
  newSession: boolean;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private readonly sessions: SessionManager;
  private readonly skills: SkillRegistry;
  private readonly opts: Required<OrchestratorOptions>;

  constructor(
    sessions: SessionManager,
    skills: SkillRegistry,
    opts: OrchestratorOptions = {}
  ) {
    this.sessions = sessions;
    this.skills = skills;
    this.opts = {
      baseSystemPrompt: opts.baseSystemPrompt ?? 'You are a helpful AI assistant.',
      maxTurns: opts.maxTurns ?? 20,
      maxMessages: opts.maxMessages ?? 40,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
    };
  }

  // ── Single turn ────────────────────────────────────────────────────────────

  async turn(input: TurnInput): Promise<TurnResult> {
    // 1. Resolve or create session.
    let session: Session;
    let newSession = false;

    if (input.sessionId) {
      const r = await this.sessions.get(input.sessionId);
      if (!r.ok) throw r.error;
      if (!r.value) throw new Error(`Session "${input.sessionId}" not found`);
      session = r.value;

      const turns = session.messages.filter((m) => m.role === 'user').length;
      if (turns >= this.opts.maxTurns) {
        throw new Error(
          `Session "${session.id}" reached the maximum of ${this.opts.maxTurns} turns.`
        );
      }
    } else {
      const r = await this.sessions.create({
        providerId: input.provider.id,
        model: input.model,
        activeSkills: input.skillIds ?? this.skills.activeIds,
      });
      if (!r.ok) throw r.error;
      session = r.value;
      newSession = true;
    }

    // 2. Resolve active skills.
    if (input.skillIds !== undefined) {
      this.skills.setActive(input.skillIds);
    }
    const activeSkills = this.skills.activeSkills();

    logger.debug('turn started', {
      sessionId: session.id,
      provider: input.provider.id,
      model: input.model,
      activeSkills: activeSkills.map((s) => s.id),
    });

    // 3. Build system prompt.
    const systemPrompt = buildSystemPrompt({
      basePrompt: this.opts.baseSystemPrompt,
      skills: activeSkills,
    });

    // 4. Persist the user message.
    const userMessage: Message = createMessage({
      role: 'user',
      content: input.userInput,
    });

    const appendUser = await this.sessions.appendMessage({
      sessionId: session.id,
      message: userMessage,
    });
    if (!appendUser.ok) throw appendUser.error;
    session = appendUser.value;

    // 5. Assemble messages for the provider.
    const { messages: assembled, dropped } = assembleMessages({
      messages: session.messages,
      maxMessages: this.opts.maxMessages,
    });

    if (dropped > 0) logger.debug('messages dropped for context window', { dropped });

    // 6. Call the provider.
    logger.debug('calling provider', {
      provider: input.provider.id,
      model: input.model,
      messageCount: assembled.length,
    });

    const chatResponse = await input.provider.chat({
      model: input.model,
      messages: assembled,
      systemPrompt,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      ...(input.signal !== undefined && { signal: input.signal }),
    });

    logger.debug('provider responded', {
      model: chatResponse.model,
      latencyMs: chatResponse.latencyMs,
      usage: chatResponse.usage,
    });

    // 7. Persist the assistant message.
    const appendAssistant = await this.sessions.appendMessage({
      sessionId: session.id,
      message: chatResponse.message,
    });
    if (!appendAssistant.ok) throw appendAssistant.error;
    session = appendAssistant.value;

    const assistantText = extractText(chatResponse.message.content);

    logger.info('turn complete', {
      sessionId: session.id,
      latencyMs: chatResponse.latencyMs,
      messages: session.messages.length,
    });

    return { chatResponse, assistantText, session, newSession };
  }

  // ── Multi-turn helper ──────────────────────────────────────────────────────

  /**
   * Run multiple turns sequentially in the same session.
   * The sessionId is threaded automatically after the first turn.
   */
  async runSequence(
    inputs: TurnInput[],
    baseOpts: Partial<Omit<TurnInput, 'userInput'>> = {}
  ): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    let sessionId: string | undefined = baseOpts.sessionId;

    for (const input of inputs) {
      const result = await this.turn({ ...baseOpts, ...input, sessionId } as TurnInput);
      results.push(result);
      sessionId = result.session.id;
    }

    return results;
  }
}
