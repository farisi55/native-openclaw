/**
 * agents/orchestrator.ts
 * v8: Reasoning-first, router-aware, semantic-memory-compressed orchestrator.
 *
 * Turn flow:
 *   input →
 *     memory extraction        → persist learned facts
 *     capability installer     → natural-language install intent?
 *     action handler           → CLI management action?
 *     reasoning engine         → decide: tool needed? which one?
 *     context compression      → semantic memory retrieval + recent window
 *     build system prompt      → memory + context + tools + base + skills
 *     ToolLoop via Router      → LLM (with auto-fallback) → tool calls → final
 *     store to semantic memory → index exchange for future retrieval
 *     return
 */

import type { IProvider, ChatOptions, ChatResponse } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage } from '../types/message';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import type { MemoryManager } from '../storage/memory-manager';
import type { ToolRegistry } from '../tools/tool-registry';
import type { ProviderRouter } from '../router/provider-router';
import { ToolLoop } from './tool-loop';
import { ReasoningEngine } from './reasoning-engine';
import { CapabilityInstaller } from './capability-installer';
import { ContextCompressor } from '../memory/context-compressor';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { handleAction, type ActionContext } from './action-handler';
import { extractMemory } from './memory-extractor';
import type { SystemContextInput } from './system-context';
import { createLogger } from '../utils/logger';
import { getOptionalEnv } from '../config/env';

const logger = createLogger('agent:orchestrator');

export interface OrchestratorOptions {
  baseSystemPrompt?: string;
  maxTurns?: number;
  maxMessages?: number;
  temperature?: number;
  maxTokens?: number;
  maxToolSteps?: number;
  /** Enable reasoning-first step. Default: true. */
  useReasoning?: boolean;
  /** Enable semantic context compression. Default: true. */
  useSemanticCompression?: boolean;
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
  assistantText: string;
  session: Session;
  newSession: boolean;
  wasAction: boolean;
  toolName?: string | undefined;
  toolsUsed?: string[];
  toolSteps?: number;
  usedFallback?: boolean;
  fallbackProvider?: string;
}

export class Orchestrator {
  private readonly sessions: SessionManager;
  private readonly skills: SkillRegistry;
  private readonly memory: MemoryManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly router: ProviderRouter;
  private readonly toolLoop: ToolLoop;
  private readonly reasoning: ReasoningEngine;
  private readonly capabilityInstaller: CapabilityInstaller;
  private readonly contextCompressor: ContextCompressor;
  private readonly opts: Required<OrchestratorOptions>;
  private _activeSessionId: string | null = null;

  constructor(
    sessions: SessionManager,
    skills: SkillRegistry,
    memory: MemoryManager,
    toolRegistry: ToolRegistry,
    router: ProviderRouter,
    contextCompressor: ContextCompressor,
    opts: OrchestratorOptions = {}
  ) {
    this.sessions          = sessions;
    this.skills            = skills;
    this.memory            = memory;
    this.toolRegistry      = toolRegistry;
    this.router            = router;
    this.contextCompressor = contextCompressor;
    this.opts = {
      baseSystemPrompt:        opts.baseSystemPrompt        ?? 'You are a helpful AI assistant.',
      maxTurns:                opts.maxTurns                ?? 20,
      maxMessages:             opts.maxMessages             ?? 40,
      temperature:             opts.temperature             ?? 0.7,
      maxTokens:               opts.maxTokens               ?? 4096,
      maxToolSteps:            opts.maxToolSteps            ?? 3,
      useReasoning:            opts.useReasoning            ?? true,
      useSemanticCompression:  opts.useSemanticCompression  ?? true,
    };
    this.toolLoop = new ToolLoop(toolRegistry, {
      maxSteps:    this.opts.maxToolSteps,
      temperature: this.opts.temperature,
      maxTokens:   this.opts.maxTokens,
    });
    this.reasoning = new ReasoningEngine(toolRegistry);
    this.capabilityInstaller = new CapabilityInstaller(toolRegistry, skills);
  }

  async turn(input: TurnInput): Promise<TurnResult> {
    // ── 1. Session ────────────────────────────────────────────────────────────
    let session: Session;
    let newSession = false;

    if (input.sessionId) {
      const r = await this.sessions.get(input.sessionId);
      if (!r.ok) throw r.error;
      if (!r.value) throw new Error(`Session "${input.sessionId}" not found`);
      session = r.value;
      const turns = session.messages.filter((m) => m.role === 'user').length;
      if (turns >= this.opts.maxTurns) {
        throw new Error(`Session "${session.id}" reached the maximum of ${this.opts.maxTurns} turns.`);
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

    // ── 2. Skills ─────────────────────────────────────────────────────────────
    if (input.skillIds !== undefined) this.skills.setActive(input.skillIds);

    // ── 3. Memory extraction ──────────────────────────────────────────────────
    const memUpdates = extractMemory(input.userInput);
    for (const upd of memUpdates) {
      if (upd.scope === 'global') {
        await this.memory.setGlobalMemory(upd.key, upd.value);
      } else {
        await this.memory.setSessionMemory(session.id, upd.key, upd.value);
      }
    }

    // ── 4. Natural-language capability install ────────────────────────────────
    const capResult = await this.capabilityInstaller.handle(input.userInput);
    if (capResult.handled) {
      session = await this.persistExchange(session.id, input.userInput, capResult.response);
      return { assistantText: capResult.response, session, newSession, wasAction: true };
    }

    // ── 5. Action handler ─────────────────────────────────────────────────────
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
      session = await this.persistExchange(session.id, input.userInput, actionResult.response ?? '');
      if (!this._activeSessionId) newSession = true;
      return { assistantText: actionResult.response ?? '', session, newSession, wasAction: true };
    }

    // ── 6. Reasoning step (internal, not shown to user) ───────────────────────
    let reasoningHint: string | null = null;
    if (this.opts.useReasoning && this.toolRegistry.size > 0) {
      const reasoning = await this.reasoning.reason(input.userInput, input.provider, input.model);
      if (reasoning.needsTool && reasoning.tool) {
        reasoningHint = reasoning.tool;
        logger.info('reasoning: tool hint', { tool: reasoningHint, reason: reasoning.reason });
      } else {
        logger.debug('reasoning: no tool needed', { reason: reasoning.reason });
      }
    }

    // ── 7. Build system prompt ────────────────────────────────────────────────
    const activeSkills = this.skills.activeSkills();
    const memoryBlock  = await this.memory.buildMemoryBlock(session.id);
    const toolsBlock   = this.toolRegistry.buildToolsBlock();
    const sysCtx: SystemContextInput = {
      provider: input.provider, model: input.model,
      skillRegistry: this.skills, sessionId: session.id,
    };
    const systemPrompt = buildSystemPrompt({
      basePrompt: this.opts.baseSystemPrompt,
      skills:     activeSkills,
      systemContext: sysCtx,
      memoryBlock,
      toolsBlock,
    });

    // ── 8. Persist user message ───────────────────────────────────────────────
    const userMessage: Message = createMessage({ role: 'user', content: input.userInput });
    const appendUser = await this.sessions.appendMessage({ sessionId: session.id, message: userMessage });
    if (!appendUser.ok) throw appendUser.error;
    session = appendUser.value;

    // ── 9. Context compression (semantic memory) ──────────────────────────────
    let contextMessages: Message[];
    if (this.opts.useSemanticCompression) {
      const compressed = this.contextCompressor.compress(
        session.messages, input.userInput, session.id,
        { recentWindowSize: Math.min(this.opts.maxMessages, 8) }
      );
      contextMessages = compressed.messages;
      if (compressed.memoriesInjected > 0) {
        logger.debug('context compressed', {
          original: compressed.originalCount,
          compressed: compressed.compressedCount,
          memoriesInjected: compressed.memoriesInjected,
        });
      }
    } else {
      const { messages, dropped } = assembleMessages({
        messages: session.messages, maxMessages: this.opts.maxMessages,
      });
      if (dropped > 0) logger.debug('messages dropped for context window', { dropped });
      contextMessages = messages;
    }

    // ── 10. ToolLoop via Router (with auto-fallback) ──────────────────────────
    logger.debug('starting tool-loop', {
      provider: input.provider.id, model: input.model,
      messageCount: contextMessages.length,
      reasoningHint,
    });

    // Custom chat fn that routes through the provider router
    const routedProvider: IProvider = {
      ...input.provider,
      chat: async (opts: ChatOptions): Promise<ChatResponse> => {
        const result = await this.router.chat(
          input.provider, input.model, opts, input.userInput
        );
        return result.response;
      },
    };

    const loopResult = await this.toolLoop.run(
      routedProvider,
      input.model,
      contextMessages,
      systemPrompt,
      input.signal,
    );

    logger.info('tool-loop complete', {
      toolSteps: loopResult.toolSteps,
      toolsUsed: loopResult.toolsUsed,
      sessionId: session.id,
    });

    // ── 11. Persist assistant response ────────────────────────────────────────
    const finalMsg = createMessage({ role: 'assistant', content: loopResult.finalText });
    const appendAssistant = await this.sessions.appendMessage({ sessionId: session.id, message: finalMsg });
    if (!appendAssistant.ok) throw appendAssistant.error;
    session = appendAssistant.value;
    this._activeSessionId = session.id;

    // ── 12. Store in semantic memory ──────────────────────────────────────────
    if (this.opts.useSemanticCompression) {
      this.contextCompressor.storeExchange(
        session.id, input.userInput, loopResult.finalText
      );
    }

    const result: TurnResult = {
      assistantText: loopResult.finalText,
      session,
      newSession,
      wasAction: false,
      toolSteps: loopResult.toolSteps,
      toolsUsed: loopResult.toolsUsed,
    };
    if (loopResult.toolsUsed.length > 0) {
      result.toolName = loopResult.toolsUsed[loopResult.toolsUsed.length - 1];
    }
    return result;
  }

  private async persistExchange(sessionId: string, userInput: string, assistantText: string): Promise<Session> {
    const userMsg = createMessage({ role: 'user',      content: userInput });
    const asstMsg = createMessage({ role: 'assistant', content: assistantText });
    const a1 = await this.sessions.appendMessage({ sessionId, message: userMsg });
    if (!a1.ok) throw a1.error;
    const a2 = await this.sessions.appendMessage({ sessionId: a1.value.id, message: asstMsg });
    if (!a2.ok) throw a2.error;
    return a2.value;
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
