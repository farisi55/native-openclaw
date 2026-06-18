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

import type { IProvider, ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import type { MemoryManager } from '../storage/memory-manager';
import type { ToolRegistry } from '../tools/tool-registry';
import type { ProviderRouter } from '../router/provider-router';
import type { McpManager } from '../mcp';
import type { McpAgentService } from '../mcp-agent';
import { ToolLoop, type ToolLoopToolResult } from './tool-loop';
import { ReasoningEngine } from './reasoning-engine';
import { CapabilityInstaller } from './capability-installer';
import { ContextCompressor } from '../memory/context-compressor';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { handleAction, type ActionContext } from './action-handler';
import { extractMemory } from './memory-extractor';
import { isSimpleChatIntent } from './simple-chat-intent';
import {
  SelfImprovingEngine,
  SkillEvaluator,
  SkillExtractor,
  SkillQualityTracker,
  SkillWriter,
  type SelfImprovingActionContext,
} from '../skills';
import type { SystemContextInput } from './system-context';
import { isWorkflowRunRequest, runWorkflowFromWorkspace } from '../workflows';
import { WorkspaceManager } from '../workspace';
import type { SchedulerActionContext } from '../scheduler';
import type { SelfHealingActionContext } from '../self-healing';
import type { AgentGatewayService } from '../agent-gateway';
import { createLogger } from '../utils/logger';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { join } from 'path';
import {
  createPromptOptimizerFromEnv,
  toPromptOptimizationApiMetadata,
  type PromptOptimizationApiMetadata,
  type PromptOptimizationResult,
  type PromptOptimizer,
} from '../prompt-optimizer';

const logger = createLogger('agent:orchestrator');

function sanitizeFlowReason(reason: string | undefined, fallback: string): string {
  const cleaned = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;

  // FIX [E2]: preserve valid operational reasons such as:
  // "I need to use web-fetch for current data" and
  // "Based on memory, user prefers bahasa Indonesia".
  // Filter only obvious internal labels at the beginning, e.g. "Reasoning: tool needed".
  if (/^(reasoning:?|thought:?|analysis:?|analisis:?|plan:?|decision:?|observation:?|internal reasoning:?|the user is asking|user is asking)\b/i.test(cleaned)) {
    return fallback;
  }

  return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
}

function shouldIncludeWorkflowContext(input: string): boolean {
  return /\b(workflow|workflow\.md|jalankan workflow|laporan|report|autonomous|otomatis|otonom)\b/i.test(input);
}

function promptSkillRelevanceEnabled(): boolean {
  return getEnvBool('PROMPT_SKILL_RELEVANCE_ENABLED', true);
}

function promptMaxActiveSkills(): number {
  return getEnvInt('PROMPT_MAX_ACTIVE_SKILLS', 3);
}

function replaceLatestUserMessage(messages: Message[], optimizedInput: string): Message[] {
  const index = [...messages].reverse().findIndex((message) => message.role === 'user');
  if (index < 0) return messages;
  const actualIndex = messages.length - 1 - index;
  return messages.map((message, currentIndex) => {
    if (currentIndex !== actualIndex) return message;
    return {
      ...message,
      content: optimizedInput,
      metadata: {
        ...(message.metadata ?? {}),
        promptOptimized: true,
      },
    };
  });
}

function estimatePromptChars(systemPrompt: string, messages: Message[]): number {
  return systemPrompt.length + messages.reduce((sum, message) => sum + extractText(message.content).length, 0);
}

function reduceContextToBudget(messages: Message[], maxChars: number): Message[] {
  let total = 0;
  const kept: Message[] = [];
  for (const message of [...messages].reverse()) {
    const text = extractText(message.content);
    if (message.role === 'user' || total + text.length <= maxChars) {
      kept.push(message);
      total += text.length;
      continue;
    }
    if (kept.length < 4) {
      const budget = Math.max(500, Math.floor(maxChars / 4));
      kept.push({
        ...message,
        content: `${text.slice(0, budget)}\n...[context trimmed by prompt optimizer]`,
      });
      total += budget;
    }
  }
  return kept.reverse();
}

interface SelfImprovingProviderSelection {
  provider: IProvider;
  model: string;
}

interface RouterProviderAccess {
  bestProvider?: (hint?: unknown) => IProvider | null;
  getProvider?: (providerId: string) => IProvider | undefined;
  allProviders?: () => IProvider[];
}

function parseSelfImprovingModel(value: string): { providerId?: string; modelId: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      providerId: trimmed.slice(0, slashIndex).trim().toLowerCase(),
      modelId: trimmed.slice(slashIndex + 1).trim(),
    };
  }
  return { modelId: trimmed };
}

async function defaultModelForProvider(provider: IProvider): Promise<string> {
  const envModel = process.env[`${provider.id.toUpperCase()}_DEFAULT_MODEL`];
  if (envModel?.trim()) return envModel.trim();
  const models = await provider.listModels();
  return models[0]?.id ?? 'default';
}

function modelInfo(modelId: string): ModelInfo {
  return {
    id: modelId,
    name: modelId,
    contextWindow: 0,
    supportsTools: false,
    supportsVision: false,
  };
}

function routerProviderAccess(router: ProviderRouter): RouterProviderAccess {
  return router as unknown as RouterProviderAccess;
}

function routerAllProviders(router: ProviderRouter): IProvider[] {
  const access = routerProviderAccess(router);
  try {
    return access.allProviders?.() ?? [];
  } catch (err) {
    logger.debug('self-improving provider list unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function routerBestProvider(router: ProviderRouter): IProvider | null {
  const access = routerProviderAccess(router);
  try {
    const best = access.bestProvider?.();
    if (best) return best;
  } catch (err) {
    logger.debug('self-improving best provider unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return routerAllProviders(router)[0] ?? null;
}

function routerGetProvider(router: ProviderRouter, providerId: string): IProvider | undefined {
  const access = routerProviderAccess(router);
  try {
    return access.getProvider?.(providerId) ?? routerAllProviders(router).find((provider) => provider.id === providerId);
  } catch (err) {
    logger.debug('self-improving provider lookup unavailable', {
      providerId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function createSelfImprovingProvider(router: ProviderRouter): IProvider | null {
  const fallbackProvider = routerBestProvider(router);
  if (!fallbackProvider) return null;

  let selectionPromise: Promise<SelfImprovingProviderSelection> | null = null;

  const fallbackSelection = async (): Promise<SelfImprovingProviderSelection> => ({
    provider: fallbackProvider,
    model: await defaultModelForProvider(fallbackProvider),
  });

  const resolveSelection = async (): Promise<SelfImprovingProviderSelection> => {
    const configured = parseSelfImprovingModel(getOptionalEnv('SELF_IMPROVING_MODEL') ?? '');
    if (!configured) return fallbackSelection();

    if (configured.providerId) {
      const provider = routerGetProvider(router, configured.providerId);
      if (!provider) {
        logger.warn('SELF_IMPROVING_MODEL provider not found; using default router', {
          configuredProvider: configured.providerId,
        });
        return fallbackSelection();
      }
      return { provider, model: configured.modelId };
    }

    const matches: IProvider[] = [];
    for (const provider of routerAllProviders(router)) {
      try {
        const models = await provider.listModels();
        if (models.some((model) => model.id === configured.modelId)) {
          matches.push(provider);
        }
      } catch (err) {
        logger.debug('self-improving model lookup skipped provider', {
          provider: provider.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (matches.length === 1) {
      return { provider: matches[0]!, model: configured.modelId };
    }

    if (matches.length > 1) {
      logger.warn('SELF_IMPROVING_MODEL is ambiguous; using default router', {
        model: configured.modelId,
        providers: matches.map((provider) => provider.id),
      });
      return fallbackSelection();
    }

    logger.warn('SELF_IMPROVING_MODEL model not found; using default router', {
      model: configured.modelId,
    });
    return fallbackSelection();
  };

  const getSelection = (): Promise<SelfImprovingProviderSelection> => {
    selectionPromise ??= resolveSelection();
    return selectionPromise;
  };

  return {
    id: 'self-improving-router',
    displayName: 'Self-Improving Router',
    async listModels() {
      const selection = await getSelection();
      return [modelInfo(selection.model)];
    },
    async chat(options: ChatOptions): Promise<ChatResponse> {
      const selection = await getSelection();
      const routed = await router.chat(
        selection.provider,
        selection.model,
        { ...options, model: selection.model },
        'self-improving skill maintenance'
      );
      return routed.response;
    },
  };
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

  /**
   * Optional deterministic MCP YAML self-configuration service.
   */
  mcpAgent?: McpAgentService;

  /**
   * Optional lightweight agent connector gateway.
   */
  agentGateway?: AgentGatewayService;

  /**
   * Optional scheduler action context for cronjob management actions.
   */
  scheduler?: SchedulerActionContext;

  /**
   * Optional autonomous self-healing/self-upgrade action context.
   */
  selfHealing?: SelfHealingActionContext;

  /**
   * Enable Self-Improving Skill Loop (Hermes-style).
   */
  selfImproving?: boolean;

  /**
   * How many tasks between self-evaluation passes. Default: 10.
   */
  selfImprovingEvalThreshold?: number;
}

export interface TurnInput {
  userInput: string;
  provider: IProvider;
  model: string;
  sessionId?: string;
  skillIds?: string[];
  signal?: AbortSignal;
  maxToolSteps?: number;
  /**
   * When true, the tool-loop enforces brevo-email after data fetch.
   * Set by scheduler executor for jobs that require email delivery.
   */
  isScheduledEmailJob?: boolean;
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
  toolResults?: ToolLoopToolResult[];
  toolSteps?: number;
  usedFallback?: boolean;
  fallbackProvider?: string;
  promptOptimization?: PromptOptimizationApiMetadata;
}

export class Orchestrator {
  private readonly sessions: SessionManager;
  private readonly skills: SkillRegistry;
  private readonly memory: MemoryManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly router: ProviderRouter;
  private readonly mcpManager: McpManager | undefined;
  private readonly mcpAgent: McpAgentService | undefined;
  private readonly agentGateway: AgentGatewayService | undefined;
  private readonly scheduler: SchedulerActionContext | undefined;
  private readonly selfHealing: SelfHealingActionContext | undefined;
  private readonly reasoning: ReasoningEngine;
  private readonly capabilityInstaller: CapabilityInstaller;
  private readonly contextCompressor: ContextCompressor;
  private readonly promptOptimizer: PromptOptimizer;
  private readonly selfImprovingEngine?: SelfImprovingEngine;
  private readonly skillsDir: string;
  private selfImprovingActionContext: SelfImprovingActionContext;
  readonly workspace: WorkspaceManager; // PERF [E1]
  private readonly opts: Required<Omit<OrchestratorOptions, 'mcpManager' | 'mcpAgent' | 'agentGateway' | 'scheduler' | 'selfHealing'>>;

  private _activeSessionId: string | null = null;
  private _workspaceReady = false;

  constructor(
    sessions: SessionManager,
    skills: SkillRegistry,
    memory: MemoryManager,
    toolRegistry: ToolRegistry,
    router: ProviderRouter,
    contextCompressor: ContextCompressor,
    workspace: WorkspaceManager,
    opts: OrchestratorOptions = {}
  ) {
    this.sessions = sessions;
    this.skills = skills;
    this.memory = memory;
    this.toolRegistry = toolRegistry;
    this.router = router;
    this.contextCompressor = contextCompressor;
    this.mcpManager = opts.mcpManager;
    this.mcpAgent = opts.mcpAgent;
    this.agentGateway = opts.agentGateway;
    this.scheduler = opts.scheduler;
    this.selfHealing = opts.selfHealing;
    this.workspace = workspace;
    const selfImproving = opts.selfImproving ?? getEnvBool('SELF_IMPROVING', false);
    const selfImprovingEvalThreshold = opts.selfImprovingEvalThreshold ?? getEnvInt('SELF_IMPROVING_EVAL_THRESHOLD', 10);
    this.skillsDir = getOptionalEnv('SKILLS_DIR') ?? './skills';
    const dataDir = getOptionalEnv('APP_DATA_DIR') ?? './data';
    const autoSkillsDir = join(this.skillsDir, 'auto-generated');

    this.opts = {
      baseSystemPrompt: opts.baseSystemPrompt ?? 'You are a helpful AI assistant.',
      maxTurns: opts.maxTurns ?? 20,
      maxMessages: opts.maxMessages ?? 40,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
      maxToolSteps: opts.maxToolSteps ?? 3,
      useReasoning: opts.useReasoning ?? true,
      useSemanticCompression: opts.useSemanticCompression ?? true,
      selfImproving,
      selfImprovingEvalThreshold,
    };

    this.reasoning = new ReasoningEngine(toolRegistry);
    this.capabilityInstaller = new CapabilityInstaller(toolRegistry, skills);
    this.promptOptimizer = createPromptOptimizerFromEnv();
    this.selfImprovingActionContext = {
      enabled: selfImproving,
      autoSkillsDir,
      qualityFilePath: join(dataDir, 'skill-quality.json'),
      evaluationThreshold: selfImprovingEvalThreshold,
    };

    if (selfImproving) {
      const selfImprovingProvider = createSelfImprovingProvider(this.router);
      if (selfImprovingProvider) {
        const extractor = new SkillExtractor(selfImprovingProvider);
        const writer = new SkillWriter(autoSkillsDir);
        const tracker = new SkillQualityTracker(dataDir, selfImprovingEvalThreshold);
        const evaluator = new SkillEvaluator(selfImprovingProvider, writer, tracker);
        this.selfImprovingEngine = new SelfImprovingEngine(
          extractor,
          writer,
          tracker,
          evaluator,
          skills,
          this.skillsDir
        );
        this.selfImprovingActionContext = {
          ...this.selfImprovingActionContext,
          engine: this.selfImprovingEngine,
        };
        tracker.load().catch((err: unknown) => {
          logger.warn('tracker load error', { error: err instanceof Error ? err.message : String(err) });
        });
      } else {
        logger.warn('self-improving disabled: no provider available for extraction');
      }
    }
  }

  getSelfImprovingActionContext(): SelfImprovingActionContext {
    return { ...this.selfImprovingActionContext };
  }

  private async ensureWorkspaceReady(): Promise<void> {
    if (this._workspaceReady) return;
    await this.workspace.ensureWorkspace();
    this._workspaceReady = true;
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

    const promptOptimizationResult: PromptOptimizationResult | null =
      await this.promptOptimizer.optimize({ userInput: input.userInput });
    const promptOptimization = toPromptOptimizationApiMetadata(promptOptimizationResult);
    const routingInput = promptOptimizationResult?.compiled.optimizedInput ?? input.userInput;
    const simpleChat =
      promptOptimizationResult?.compiled.routingHint === 'simple-chat' ||
      isSimpleChatIntent(input.userInput);

    if (promptOptimization) {
      flow.push({
        stage: 'prompt_optimizer',
        intent: promptOptimization.intent,
        originalChars: promptOptimization.originalChars,
        optimizedChars: promptOptimization.optimizedChars,
        compressionApplied: promptOptimization.compressionApplied,
        routingHint: promptOptimization.routingHint ?? null,
      });
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

    await this.ensureWorkspaceReady();

    for (const update of memoryUpdates) {
      const summary = `${update.key}: ${update.value}`;
      await this.workspace.appendLongTermMemory(summary);
      await this.workspace.appendDailyMemory({
        type: 'user_preference',
        summary,
        source: 'chat',
        details: `Stored as ${update.scope} memory for session ${session.id}.`,
      });
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
    if (isWorkflowRunRequest(routingInput)) {
      const workflowResult = await runWorkflowFromWorkspace({
        ...(this.mcpManager ? { mcpManager: this.mcpManager } : {}),
        toolRegistry: this.toolRegistry,
        provider: input.provider,
        model: input.model,
        workspace: this.workspace,
      });

      await this.workspace.appendDailyMemory({
        type: 'workflow_event',
        summary: `Workflow executed: ${workflowResult.title}`,
        source: 'workflow',
        details: workflowResult.content.slice(0, 1000),
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
          ...flow,
          {
            stage: 'final',
            type: 'workflow',
            workflow: workflowResult.title,
            tools: workflowResult.toolsUsed,
          },
        ],
        toolsUsed: workflowResult.toolsUsed,
        ...(promptOptimization ? { promptOptimization } : {}),
      };
    }

    // ── 5. Action handler ─────────────────────────────────────────────────────
    const actionContext: ActionContext = {
      skillRegistry: this.skills,
      sessions: this.sessions,
      skillsDir: this.skillsDir,
      activeSessionId: this._activeSessionId,
      ...(this.mcpManager ? { mcpManager: this.mcpManager } : {}),
      ...(this.mcpAgent ? { mcpAgent: this.mcpAgent } : {}),
      ...(this.agentGateway ? { agentGateway: this.agentGateway } : {}),
      ...(this.scheduler ? { scheduler: this.scheduler } : {}),
      selfImproving: this.selfImprovingActionContext,
      ...(this.selfHealing ? { selfHealing: this.selfHealing } : {}),
      onSessionCleared: () => {
        this._activeSessionId = null;
      },
    };

    const actionResult = await handleAction(
      routingInput,
      actionContext,
      promptOptimizationResult?.compiled
    );

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

      if (this.opts.selfImproving && this.selfImprovingEngine) {
        void this.selfImprovingEngine
          .processCompletedTurn({
            userInput: input.userInput,
            agentResponse: responseText,
            toolsUsed: [],
            stepCount: 0,
            sessionId: session.id,
            wasSchedulerAction: actionResult.actionType === 'scheduler_create',
          })
          .catch((err: unknown) => {
            logger.warn('self-improving (action) error (non-fatal)', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
      }

      return {
        assistantText: responseText,
        session,
        newSession,
        wasAction: true,
        flow: [...flow, { stage: 'final', type: 'action' }],
        ...(promptOptimization ? { promptOptimization } : {}),
      };
    }

    // ── 6. Reasoning step, internal only ──────────────────────────────────────
    const capabilityResult = await this.capabilityInstaller.handle(routingInput);

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
        flow: [...flow, { stage: 'final', type: 'capability_action' }],
        ...(promptOptimization ? { promptOptimization } : {}),
      };
    }

    let reasoningHint: string | null = null;

    if (!simpleChat && this.opts.useReasoning && this.toolRegistry.size > 0) {
      const reasoningResult = await this.reasoning.reason(
        routingInput,
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
    const activeSkills = this.skills.relevantActiveSkills(routingInput, {
      enabled: promptSkillRelevanceEnabled(),
      maxSkills: promptMaxActiveSkills(),
    });
    const activeSkillsUsed = activeSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      filePath: skill.filePath,
    }));
    const memoryBlock = await this.memory.buildMemoryBlock(session.id, { minimal: simpleChat });
    const workspaceContext = simpleChat
      ? null
      : await this.workspace.buildContext({
          includeWorkflow: shouldIncludeWorkflowContext(routingInput),
        });
    const toolsBlock = simpleChat ? null : this.toolRegistry.buildToolsBlock();

    const systemContext: SystemContextInput = {
      provider: input.provider,
      model: input.model,
      skillRegistry: this.skills,
      sessionId: session.id,
    };

    let systemPrompt = buildSystemPrompt({
      basePrompt: this.opts.baseSystemPrompt,
      skills: activeSkills,
      systemContext,
      memoryBlock,
      workspaceContext,
      toolsBlock,
    });

    if (promptOptimizationResult?.compiled.systemAddendum) {
      systemPrompt = `${systemPrompt}\n\n${promptOptimizationResult.compiled.systemAddendum}`;
    }

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
        routingInput,
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

    if (promptOptimizationResult) {
      contextMessages = replaceLatestUserMessage(contextMessages, routingInput);
      const maxPromptChars = promptOptimizationResult.compiled.tokenBudget.maxInputChars;
      const estimatedChars = estimatePromptChars(systemPrompt, contextMessages);
      if (estimatedChars > maxPromptChars) {
        contextMessages = reduceContextToBudget(contextMessages, Math.max(2000, maxPromptChars - systemPrompt.length));
        flow.push({
          stage: 'prompt_optimizer',
          action: 'context_budget_reduced',
          beforeChars: estimatedChars,
          afterChars: estimatePromptChars(systemPrompt, contextMessages),
        });
        logger.warn('Prompt optimizer reduced context to avoid Request too large', {
          beforeChars: estimatedChars,
          afterChars: estimatePromptChars(systemPrompt, contextMessages),
        });
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
      maxSteps: input.maxToolSteps ?? this.opts.maxToolSteps,
      temperature: this.opts.temperature,
      maxTokens: this.opts.maxTokens,
      preferredTool: reasoningHint,
      enableTools: !simpleChat,
      enableRepair: true,
      maxRepairAttempts: 2,
      isScheduledEmailJob: input.isScheduledEmailJob ?? false,
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
          routingInput
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
    if (simpleChat) {
      contextMessages = session.messages.slice(-4);
    } else if (this.opts.useSemanticCompression) {
      Promise.resolve(
        this.contextCompressor.storeExchange(
          session.id,
          input.userInput,
          loopResult.finalText
        )
      ).catch((err: unknown) => {
        logger.warn('orchestrator: storeExchange failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const result: TurnResult = {
      assistantText: loopResult.finalText,
      session,
      newSession,
      wasAction: false,
      flow: [...flow, { stage: 'final' }],
      toolSteps: loopResult.toolSteps,
      toolsUsed: loopResult.toolsUsed,
      ...(loopResult.toolResults ? { toolResults: loopResult.toolResults } : {}),
      usedFallback,
      ...(promptOptimization ? { promptOptimization } : {}),
    };

    if (this.opts.selfImproving && this.selfImprovingEngine) {
      this.selfImprovingEngine
        .processCompletedTurn({
          userInput: input.userInput,
          agentResponse: loopResult.finalText,
          toolsUsed: loopResult.toolsUsed ?? [],
          stepCount: loopResult.toolSteps ?? 0,
          sessionId: session.id,
          activeSkillsUsed,
        })
        .catch((err: unknown) => {
          logger.warn('self-improving error (non-fatal)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

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
