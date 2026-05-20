/**
 * agents/orchestrator.ts
 * Reasoning-first, router-aware, semantic-memory-compressed orchestrator.
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
import type { McpManager } from '../mcp';
import { ToolLoop } from './tool-loop';
import { ReasoningEngine } from './reasoning-engine';
import { CapabilityInstaller } from './capability-installer';
import { ContextCompressor } from '../memory/context-compressor';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { handleAction, type ActionContext } from './action-handler';
import { extractMemory } from './memory-extractor';
import type { SystemContextInput } from './system-context';
import { isWorkflowRunRequest, runWorkflowFromWorkspace } from '../workflows';
import { createLogger } from '../utils/logger';
import { getOptionalEnv } from '../config/env';

const logger = createLogger('agent:orchestrator');

function sanitizeFlowReason(reason: string | undefined, fallback: string): string {
  const cleaned = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;

  if (/(the user is asking|user is asking|from the memory|based on memory|i should|i need to|reasoning:|thought:|analysis:|plan:|decision:|observation:|internal reasoning)/i.test(cleaned)) {
    return fallback;
  }

  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

export interface OrchestratorOptions {
  baseSystemPrompt?: string;

  /**
   * Maximum user turns allowed in one session.
   */
  maxTurns?: number;

  /**
   * Maximum messages injected into the context window.
   */
  maxMessages?: number;

  /**
   * Default model temperature.
   */
  temperature?: number;

  /**
   * Default max output tokens.
   */
  maxTokens?: number;

  /**
   * Maximum tool calls allowed in one loop.
   */
  maxToolSteps?: number;

  /**
   * Enable reasoning-first planning stage.
   * Default: true
   */
  useReasoning?: boolean;

  /**
   * Enable semantic memory compression/context retrieval.
   * Default: true
   */
  useSemanticCompression?: boolean;

  /**
   * Optional MCP manager for natural-language MCP management actions.
   */
  mcpManager?: McpManager;
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
  flow: Array<Record<string, unknown>>;
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
  private readonly mcpManager: McpManager | undefined;
  private readonly reasoning: ReasoningEngine;
  private readonly capabilityInstaller: CapabilityInstaller;
  private readonly contextCompressor: ContextCompressor;
  private readonly opts: Required<Omit<OrchestratorOptions, 'mcpManager'>>;

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
    this.sessions = sessions;
    this.skills = skills;
    this.memory = memory;
    this.toolRegistry = toolRegistry;
    this.router = router;
    this.contextCompressor = contextCompressor;
    this.mcpManager = opts.mcpManager;

    this.opts = {
      baseSystemPrompt: opts.baseSystemPrompt ?? 'You are a helpful AI assistant.',
      maxTurns: opts.maxTurns ?? 20,
      maxMessages: opts.maxMessages ?? 40,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
      maxToolSteps: opts.maxToolSteps ?? 3,
      useReasoning: opts.useReasoning ?? true,
      useSemanticCompression: opts.useSemanticCompression ?? true,
    };

    this.reasoning = new ReasoningEngine(toolRegistry);
    this.capabilityInstaller = new CapabilityInstaller(toolRegistry, skills);
  }

  async turn(input: TurnInput): Promise<TurnResult> {
    // ── 1. Session ────────────────────────────────────────────────────────────
    let session: Session;
    let newSession = false;
    const flow: Array<Record<string, unknown>> = [];

    if (input.sessionId) {
      const sessionResult = await this.sessions.get(input.sessionId);

      if (!sessionResult.ok) {
        throw sessionResult.error;
      }

      if (!sessionResult.value) {
        throw new Error(`Session "${input.sessionId}" not found`);
      }

      session = sessionResult.value;

      const userTurns = session.messages.filter((m) => m.role === 'user').length;

      if (userTurns >= this.opts.maxTurns) {
        throw new Error(
          `Session "${session.id}" reached the maximum of ${this.opts.maxTurns} turns.`
        );
      }
    } else {
      const createResult = await this.sessions.create({
        providerId: input.provider.id,
        model: input.model,
        activeSkills: input.skillIds ?? this.skills.activeIds,
      });

      if (!createResult.ok) {
        throw createResult.error;
      }

      session = createResult.value;
      newSession = true;
    }

    this._activeSessionId = session.id;

    // ── 2. Skills ─────────────────────────────────────────────────────────────
    if (input.skillIds !== undefined) {
      this.skills.setActive(input.skillIds);
    }

    // ── 3. Memory extraction ──────────────────────────────────────────────────
    const memoryUpdates = extractMemory(input.userInput);

    for (const update of memoryUpdates) {
      if (update.scope === 'global') {
        await this.memory.setGlobalMemory(update.key, update.value);
      } else {
        await this.memory.setSessionMemory(session.id, update.key, update.value);
      }
    }

    // ── 4. Natural-language capability install ────────────────────────────────
    /**
     * Turn processing priority order:
     * 1. Memory extraction (always runs, no early return)
     * 2. Workflow run request (explicit "jalankan workflow" trigger)
     * 3. Action handler (session management, skill management)
     * 4. Capability installer (natural language tool/skill install)
     * 5. Reasoning + ToolLoop (main LLM pipeline)
     */
    if (isWorkflowRunRequest(input.userInput)) {
      const workflowResult = await runWorkflowFromWorkspace({
        ...(this.mcpManager ? { mcpManager: this.mcpManager } : {}),
        toolRegistry: this.toolRegistry,
        provider: input.provider,
        model: input.model,
      });

      session = await this.persistExchange(
        session.id,
        input.userInput,
        workflowResult.content
      );

      return {
        assistantText: workflowResult.content,
        session,
        newSession,
        wasAction: true,
        flow: [
          {
            stage: 'final',
            type: 'workflow',
            workflow: workflowResult.title,
            tools: workflowResult.toolsUsed,
          },
        ],
        toolsUsed: workflowResult.toolsUsed,
      };
    }

    // ── 5. Action handler ─────────────────────────────────────────────────────
    const skillsDir = getOptionalEnv('SKILLS_DIR') ?? './skills';

    const actionContext: ActionContext = {
      skillRegistry: this.skills,
      sessions: this.sessions,
      skillsDir,
      activeSessionId: this._activeSessionId,
      ...(this.mcpManager ? { mcpManager: this.mcpManager } : {}),
      onSessionCleared: () => {
        this._activeSessionId = null;
      },
    };

    const actionResult = await handleAction(input.userInput, actionContext);

    if (actionResult.handled) {
      const responseText = actionResult.response ?? '';

      session = await this.persistExchange(
        session.id,
        input.userInput,
        responseText
      );

      if (!this._activeSessionId) {
        newSession = true;
      }

      return {
        assistantText: responseText,
        session,
        newSession,
        wasAction: true,
        flow: [{ stage: 'final', type: 'action' }],
      };
    }

    // ── 6. Reasoning step, internal only ──────────────────────────────────────
    const capabilityResult = await this.capabilityInstaller.handle(input.userInput);

    if (capabilityResult.handled) {
      session = await this.persistExchange(
        session.id,
        input.userInput,
        capabilityResult.response
      );

      return {
        assistantText: capabilityResult.response,
        session,
        newSession,
        wasAction: true,
        flow: [{ stage: 'final', type: 'capability_action' }],
      };
    }

    let reasoningHint: string | null = null;

    if (this.opts.useReasoning && this.toolRegistry.size > 0) {
      const reasoningResult = await this.reasoning.reason(
        input.userInput,
        input.provider,
        input.model
      );

      if (reasoningResult.needsTool && reasoningResult.tool) {
        reasoningHint = reasoningResult.tool;
        flow.push({
          stage: 'reasoning',
          needsTool: true,
          tool: reasoningHint,
          reason: sanitizeFlowReason(reasoningResult.reason, 'Tool likely needed'),
        });

        logger.info('reasoning: tool hint', {
          tool: reasoningHint,
          reason: reasoningResult.reason,
        });
      } else {
        flow.push({
          stage: 'reasoning',
          needsTool: false,
          tool: null,
          reason: sanitizeFlowReason(reasoningResult.reason, 'No tool needed'),
        });
        logger.debug('reasoning: no tool needed', {
          reason: reasoningResult.reason,
        });
      }
    }

    // ── 7. Build system prompt ────────────────────────────────────────────────
    const activeSkills = this.skills.activeSkills();
    const memoryBlock = await this.memory.buildMemoryBlock(session.id);
    const toolsBlock = this.toolRegistry.buildToolsBlock();

    const systemContext: SystemContextInput = {
      provider: input.provider,
      model: input.model,
      skillRegistry: this.skills,
      sessionId: session.id,
    };

    const systemPrompt = buildSystemPrompt({
      basePrompt: this.opts.baseSystemPrompt,
      skills: activeSkills,
      systemContext,
      memoryBlock,
      toolsBlock,
    });

    // ── 8. Persist user message ───────────────────────────────────────────────
    const userMessage: Message = createMessage({
      role: 'user',
      content: input.userInput,
    });

    const appendUserResult = await this.sessions.appendMessage({
      sessionId: session.id,
      message: userMessage,
    });

    if (!appendUserResult.ok) {
      throw appendUserResult.error;
    }

    session = appendUserResult.value;

    // ── 9. Context compression ────────────────────────────────────────────────
    let contextMessages: Message[];

    if (this.opts.useSemanticCompression) {
      const compressed = this.contextCompressor.compress(
        session.messages,
        input.userInput,
        session.id,
        {
          recentWindowSize: Math.min(this.opts.maxMessages, 8),
        }
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
        messages: session.messages,
        maxMessages: this.opts.maxMessages,
      });

      contextMessages = messages;

      if (dropped > 0) {
        logger.debug('messages dropped for context window', { dropped });
      }
    }

    // ── 10. ToolLoop via Router ───────────────────────────────────────────────
    logger.debug('starting tool-loop', {
      provider: input.provider.id,
      model: input.model,
      messageCount: contextMessages.length,
      reasoningHint,
    });

    const dynamicToolLoop = new ToolLoop(this.toolRegistry, {
      maxSteps: this.opts.maxToolSteps,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      preferredTool: reasoningHint,
      enableRepair: true,
      maxRepairAttempts: 2,
    });

    let routedProviderId = input.provider.id;
    let routedModel = input.model;
    let usedFallback = false;

    const routedProvider: IProvider = {
      ...input.provider,
      chat: async (chatOptions: ChatOptions): Promise<ChatResponse> => {
        const routedResult = await this.router.chat(
          input.provider,
          input.model,
          chatOptions,
          input.userInput
        );

        routedProviderId = routedResult.providerId;
        routedModel = routedResult.model;
        usedFallback = routedResult.usedFallback;

        return routedResult.response;
      },
    };

    const loopResult = await dynamicToolLoop.run(
      routedProvider,
      input.model,
      contextMessages,
      systemPrompt,
      input.signal
    );

    flow.push(...loopResult.flow);
    if (usedFallback) {
      flow.push({
        stage: 'provider_fallback',
        provider: routedProviderId,
        model: routedModel,
      });
    }

    logger.info('tool-loop complete', {
      toolSteps: loopResult.toolSteps,
      toolsUsed: loopResult.toolsUsed,
      sessionId: session.id,
    });

    // ── 11. Persist assistant response ────────────────────────────────────────
    const assistantMessage = createMessage({
      role: 'assistant',
      content: loopResult.finalText,
    });

    const appendAssistantResult = await this.sessions.appendMessage({
      sessionId: session.id,
      message: assistantMessage,
    });

    if (!appendAssistantResult.ok) {
      throw appendAssistantResult.error;
    }

    session = appendAssistantResult.value;
    this._activeSessionId = session.id;

    // ── 12. Store semantic memory ─────────────────────────────────────────────
    if (this.opts.useSemanticCompression) {
      this.contextCompressor.storeExchange(
        session.id,
        input.userInput,
        loopResult.finalText
      );
    }

    const result: TurnResult = {
      assistantText: loopResult.finalText,
      session,
      newSession,
      wasAction: false,
      flow: [...flow, { stage: 'final' }],
      toolSteps: loopResult.toolSteps,
      toolsUsed: loopResult.toolsUsed,
      usedFallback,
    };

    if (usedFallback) {
      result.fallbackProvider = routedProviderId;
    }

    if (loopResult.toolsUsed.length > 0) {
      result.toolName = loopResult.toolsUsed[loopResult.toolsUsed.length - 1];
    }

    return result;
  }

  private async persistExchange(
    sessionId: string,
    userInput: string,
    assistantText: string
  ): Promise<Session> {
    const userMessage = createMessage({
      role: 'user',
      content: userInput,
    });

    const assistantMessage = createMessage({
      role: 'assistant',
      content: assistantText,
    });

    const appendUserResult = await this.sessions.appendMessage({
      sessionId,
      message: userMessage,
    });

    if (!appendUserResult.ok) {
      throw appendUserResult.error;
    }

    const appendAssistantResult = await this.sessions.appendMessage({
      sessionId: appendUserResult.value.id,
      message: assistantMessage,
    });

    if (!appendAssistantResult.ok) {
      throw appendAssistantResult.error;
    }

    return appendAssistantResult.value;
  }

  async runSequence(
    inputs: TurnInput[],
    baseOpts: Partial<Omit<TurnInput, 'userInput'>> = {}
  ): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    let sessionId: string | undefined = baseOpts.sessionId;

    for (const input of inputs) {
      const result = await this.turn({
        ...baseOpts,
        ...input,
        sessionId,
      } as TurnInput);

      results.push(result);
      sessionId = result.session.id;
    }

    return results;
  }
}
