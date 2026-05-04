/**
 * agents/orchestrator.ts
 * Main agent loop.
 *
 * Flow per turn:
 *   input → action-handler → if action: return immediately
 *                           → else: build prompt → call LLM → persist → return
 */

import type { IProvider, ChatResponse } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { handleAction, type ActionContext } from './action-handler';
import type { SystemContextInput } from './system-context';
import { createLogger } from '../utils/logger';
import { getOptionalEnv } from '../config/env';

const logger = createLogger('agent:orchestrator');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorOptions {
  baseSystemPrompt?: string;
  maxTurns?: number;
  maxMessages?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface TurnInput {
  userInput: string;
  provider: IProvider;
  model: string;
  sessionId?: string;
  skillIds?: string[];
  signal?: AbortSignal;
}

export interface TurnResult {
  chatResponse?: ChatResponse;
  /** Plain text reply — set for both LLM and action results. */
  assistantText: string;
  session: Session;
  newSession: boolean;
  /** true when the turn was handled by the action-handler (no LLM call). */
  wasAction: boolean;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private readonly sessions: SessionManager;
  private readonly skills: SkillRegistry;
  private readonly opts: Required<OrchestratorOptions>;

  /** Mutable active-session ref shared with the action-handler. */
  private _activeSessionId: string | null = null;

  constructor(
    sessions: SessionManager,
    skills: SkillRegistry,
    opts: OrchestratorOptions = {}
  ) {
    this.sessions = sessions;
    this.skills = skills;
    this.opts = {
      baseSystemPrompt: opts.baseSystemPrompt ?? 'You are a helpful AI assistant.',
      maxTurns:         opts.maxTurns ?? 20,
      maxMessages:      opts.maxMessages ?? 40,
      temperature:      opts.temperature ?? 0.7,
      maxTokens:        opts.maxTokens ?? 4096,
    };
  }

  // ── Single turn ────────────────────────────────────────────────────────────

  async turn(input: TurnInput): Promise<TurnResult> {
    // ── 1. Resolve or create session ─────────────────────────────────────────
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

    this._activeSessionId = session.id;

    // ── 2. Resolve active skills ──────────────────────────────────────────────
    if (input.skillIds !== undefined) {
      this.skills.setActive(input.skillIds);
    }

    // ── 3. Action-handler (intercept before LLM) ──────────────────────────────
    const skillsDir = getOptionalEnv('SKILLS_DIR') ?? './skills';
    const actionCtx: ActionContext = {
      skillRegistry:    this.skills,
      sessions:         this.sessions,
      skillsDir,
      activeSessionId:  this._activeSessionId,
      onSessionCleared: () => { this._activeSessionId = null; },
    };

    const actionResult = await handleAction(input.userInput, actionCtx);

    if (actionResult.handled) {
      // Persist the user message + action response as an assistant message
      const userMsg = createMessage({ role: 'user',      content: input.userInput });
      const asstMsg = createMessage({ role: 'assistant', content: actionResult.response ?? '' });

      const a1 = await this.sessions.appendMessage({ sessionId: session.id, message: userMsg });
      if (!a1.ok) throw a1.error;
      const a2 = await this.sessions.appendMessage({ sessionId: a1.value.id, message: asstMsg });
      if (!a2.ok) throw a2.error;
      session = a2.value;

      // If session was cleared by the action (delete self), reset id
      if (!this._activeSessionId) {
        newSession = true;
      } else {
        this._activeSessionId = session.id;
      }

      logger.info('action handled', { action: input.userInput.slice(0, 40) });

      return {
        assistantText: actionResult.response ?? '',
        session,
        newSession,
        wasAction: true,
      };
    }

    // ── 4. Build system prompt with context ───────────────────────────────────
    const activeSkills = this.skills.activeSkills();

    const sysCtx: SystemContextInput = {
      provider:      input.provider,
      model:         input.model,
      skillRegistry: this.skills,
      sessionId:     session.id,
    };

    const systemPrompt = buildSystemPrompt({
      basePrompt:    this.opts.baseSystemPrompt,
      skills:        activeSkills,
      systemContext: sysCtx,
    });

    // ── 5. Persist user message ───────────────────────────────────────────────
    const userMessage: Message = createMessage({ role: 'user', content: input.userInput });
    const appendUser = await this.sessions.appendMessage({
      sessionId: session.id,
      message: userMessage,
    });
    if (!appendUser.ok) throw appendUser.error;
    session = appendUser.value;

    // ── 6. Assemble sliding window ────────────────────────────────────────────
    const { messages: assembled, dropped } = assembleMessages({
      messages: session.messages,
      maxMessages: this.opts.maxMessages,
    });
    if (dropped > 0) logger.debug('messages dropped for context window', { dropped });

    // ── 7. Call LLM ───────────────────────────────────────────────────────────
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
    });

    // ── 8. Persist assistant message ──────────────────────────────────────────
    const appendAssistant = await this.sessions.appendMessage({
      sessionId: session.id,
      message: chatResponse.message,
    });
    if (!appendAssistant.ok) throw appendAssistant.error;
    session = appendAssistant.value;
    this._activeSessionId = session.id;

    const assistantText = extractText(chatResponse.message.content);

    logger.info('turn complete', {
      sessionId: session.id,
      latencyMs: chatResponse.latencyMs,
      messages: session.messages.length,
    });

    return { chatResponse, assistantText, session, newSession, wasAction: false };
  }

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
