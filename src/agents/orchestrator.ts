/**
 * agents/orchestrator.ts
 * Main agent loop.
 *
 * Turn flow:
 *   input →
 *     memory-extractor      → persist learned facts
 *     tool-executor (rules) → if rule match: execute, return immediately
 *     action-handler        → if CLI action: execute, return immediately
 *     build prompt          → memory + context + tools + base + skills
 *     call LLM              → persist messages
 *     tool-executor (LLM)   → if LLM suggests tool call: execute, append result
 *     return
 */

import type { IProvider, ChatResponse } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import type { MemoryManager } from '../storage/memory-manager';
import type { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutor } from '../tools/tool-executor';
import { buildSystemPrompt } from './prompt-builder';
import { assembleMessages } from './message-assembler';
import { handleAction, type ActionContext } from './action-handler';
import { extractMemory } from './memory-extractor';
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
  assistantText: string;
  session: Session;
  newSession: boolean;
  wasAction: boolean;
  toolName?: string | undefined;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export class Orchestrator {
  private readonly sessions: SessionManager;
  private readonly skills: SkillRegistry;
  private readonly memory: MemoryManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly opts: Required<OrchestratorOptions>;
  private _activeSessionId: string | null = null;

  constructor(
    sessions: SessionManager,
    skills: SkillRegistry,
    memory: MemoryManager,
    toolRegistry: ToolRegistry,
    opts: OrchestratorOptions = {}
  ) {
    this.sessions = sessions;
    this.skills = skills;
    this.memory = memory;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = new ToolExecutor(toolRegistry);
    this.opts = {
      baseSystemPrompt: opts.baseSystemPrompt ?? 'You are a helpful AI assistant.',
      maxTurns:         opts.maxTurns ?? 20,
      maxMessages:      opts.maxMessages ?? 40,
      temperature:      opts.temperature ?? 0.7,
      maxTokens:        opts.maxTokens ?? 4096,
    };
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

    // ── 4. Tool executor — rule-based (before LLM, zero latency) ─────────────
    const ruleResult = await this.toolExecutor.tryRuleBased(input.userInput);
    if (ruleResult.handled) {
      session = await this.persistExchange(session.id, input.userInput, ruleResult.response ?? '');
      logger.info('tool handled (rule)', { tool: ruleResult.toolName });
      const ret: TurnResult = { assistantText: ruleResult.response ?? '', session, newSession, wasAction: true };
      if (ruleResult.toolName !== undefined) ret.toolName = ruleResult.toolName;
      return ret;
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
      else this._activeSessionId = session.id;
      logger.info('action handled', { action: input.userInput.slice(0, 40) });
      return { assistantText: actionResult.response ?? '', session, newSession, wasAction: true };
    }

    // ── 6. Build system prompt ────────────────────────────────────────────────
    const activeSkills = this.skills.activeSkills();
    const memoryBlock  = await this.memory.buildMemoryBlock(session.id);
    const toolsBlock   = this.toolRegistry.buildToolsBlock();
    const sysCtx: SystemContextInput = {
      provider: input.provider, model: input.model,
      skillRegistry: this.skills, sessionId: session.id,
    };

    const systemPrompt = buildSystemPrompt({
      basePrompt:    this.opts.baseSystemPrompt,
      skills:        activeSkills,
      systemContext: sysCtx,
      memoryBlock,
      toolsBlock,
    });

    // ── 7. Persist user message ───────────────────────────────────────────────
    const userMessage: Message = createMessage({ role: 'user', content: input.userInput });
    const appendUser = await this.sessions.appendMessage({ sessionId: session.id, message: userMessage });
    if (!appendUser.ok) throw appendUser.error;
    session = appendUser.value;

    // ── 8. Sliding window ─────────────────────────────────────────────────────
    const { messages: assembled, dropped } = assembleMessages({
      messages: session.messages, maxMessages: this.opts.maxMessages,
    });
    if (dropped > 0) logger.debug('messages dropped for context window', { dropped });

    // ── 9. Call LLM ───────────────────────────────────────────────────────────
    logger.debug('calling provider', {
      provider: input.provider.id, model: input.model,
      messageCount: assembled.length, hasMemory: Boolean(memoryBlock),
      hasTools: Boolean(toolsBlock),
    });

    const chatResponse = await input.provider.chat({
      model: input.model, messages: assembled, systemPrompt,
      temperature: this.opts.temperature, maxTokens: this.opts.maxTokens,
      ...(input.signal !== undefined && { signal: input.signal }),
    });

    logger.debug('provider responded', { model: chatResponse.model, latencyMs: chatResponse.latencyMs });

    // ── 10. LLM-assisted tool execution ──────────────────────────────────────
    const llmText = extractText(chatResponse.message.content);
    const llmToolResult = await this.toolExecutor.tryLLMAssisted(llmText);

    let finalText = llmText;
    let finalToolName: string | undefined;

    if (llmToolResult.handled && llmToolResult.response) {
      // Replace LLM response with actual tool output
      finalText = llmToolResult.response;
      finalToolName = llmToolResult.toolName;
      logger.info('tool handled (LLM-assisted)', { tool: finalToolName });
    }

    // ── 11. Persist assistant message ─────────────────────────────────────────
    const finalMsg = createMessage({ role: 'assistant', content: finalText });
    const appendAssistant = await this.sessions.appendMessage({ sessionId: session.id, message: finalMsg });
    if (!appendAssistant.ok) throw appendAssistant.error;
    session = appendAssistant.value;
    this._activeSessionId = session.id;

    logger.info('turn complete', { sessionId: session.id, latencyMs: chatResponse.latencyMs });

    const result: TurnResult = {
      chatResponse, assistantText: finalText, session, newSession, wasAction: false,
    };
    if (finalToolName !== undefined) result.toolName = finalToolName;
    return result;
  }

  // ── Helper: persist user + assistant message pair ────────────────────────

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
