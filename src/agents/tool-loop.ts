/**
 * agents/tool-loop.ts
 * Multi-step LLM ↔ Tool execution loop.
 *
 * Implements the agentic reasoning cycle:
 *
 *   user input →
 *     LLM (with tools in system prompt) →
 *       if tool_call → execute tool → inject result → LLM again →
 *         ... (up to maxSteps) ...
 *       if final_response → return
 *       if plain text → return as-is
 *
 * This is provider-agnostic: works with Ollama, Groq, Gemini, etc.
 * No streaming required — all synchronous request/response.
 */

import type { IProvider } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage } from '../types/message';
import type { ToolRegistry } from '../tools/tool-registry';
import { parseLLMResponse, validateToolCall } from './tool-parser';
import { createLogger } from '../utils/logger';

const logger = createLogger('agents:tool-loop');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  /** Maximum number of tool calls in a single turn. Default: 3. */
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface ToolLoopResult {
  /** The final text response to show the user. */
  finalText: string;
  /** Number of tool steps executed. 0 = went straight to final response. */
  toolSteps: number;
  /** Names of tools that were called (in order). */
  toolsUsed: string[];
  /** Raw LLM response messages for each step (for debugging). */
  stepMessages: Message[];
}

// ─── Helper: build tool result injection message ──────────────────────────────

function buildToolResultMessage(toolName: string, result: string): Message {
  return createMessage({
    role: 'user',
    content: `TOOL RESULT [${toolName}]:\n\n${result}\n\nBased on the above tool result, provide your final answer to the user.`,
  });
}

// ─── Tool Loop ────────────────────────────────────────────────────────────────

export class ToolLoop {
  private readonly registry: ToolRegistry;
  private readonly opts: Required<ToolLoopOptions>;

  constructor(registry: ToolRegistry, opts: ToolLoopOptions = {}) {
    this.registry = registry;
    this.opts = {
      maxSteps: opts.maxSteps ?? 3,
      temperature: opts.temperature ?? 0.7,
      maxTokens: opts.maxTokens ?? 4096,
    };
  }

  /**
   * Run the agentic loop for a single user turn.
   *
   * @param provider      - The active LLM provider.
   * @param model         - Model ID to use.
   * @param messages      - Current conversation history (assembled sliding window).
   * @param systemPrompt  - Full system prompt (includes tools block).
   * @param signal        - Optional abort signal.
   */
  async run(
    provider: IProvider,
    model: string,
    messages: Message[],
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<ToolLoopResult> {
    const availableTools = this.registry.listTools().map((t) => t.manifest.name);
    const stepMessages: Message[] = [];
    const toolsUsed: string[] = [];
    let toolSteps = 0;

    // Working copy of messages — may grow as we inject tool results
    let currentMessages = [...messages];

    for (let step = 0; step <= this.opts.maxSteps; step++) {
      const isLastStep = step === this.opts.maxSteps;

      // If we've hit the step limit, append a nudge to force a final answer
      if (isLastStep && toolSteps > 0) {
        currentMessages = [
          ...currentMessages,
          createMessage({
            role: 'user',
            content: 'Please provide your final answer based on the information gathered so far.',
          }),
        ];
      }

      logger.debug('tool-loop LLM call', {
        step, model, messageCount: currentMessages.length, toolSteps,
      });

      // Call LLM
      let llmText: string;
      try {
        const response = await provider.chat({
          model,
          messages: currentMessages,
          systemPrompt,
          temperature: this.opts.temperature,
          maxTokens: this.opts.maxTokens,
          ...(signal !== undefined && { signal }),
        });
        const { extractText } = require('../types/message') as typeof import('../types/message');
        llmText = extractText(response.message.content);
      } catch (e) {
        const errMsg = `LLM call failed at step ${step}: ${String(e)}`;
        logger.warn(errMsg);
        return { finalText: `❌ ${errMsg}`, toolSteps, toolsUsed, stepMessages };
      }

      stepMessages.push(createMessage({ role: 'assistant', content: llmText }));

      // Parse the LLM response
      const parsed = parseLLMResponse(llmText);

      // Case 1: LLM wants to call a tool
      if (parsed?.type === 'tool_call') {
        if (isLastStep) {
          // No more steps — return the raw text as fallback
          logger.warn('tool-loop: max steps reached, returning raw LLM text');
          return { finalText: llmText, toolSteps, toolsUsed, stepMessages };
        }

        // Validate tool
        const validationError = validateToolCall(parsed, availableTools);
        if (validationError) {
          logger.warn('tool-loop: invalid tool call', { error: validationError });
          return { finalText: `❌ ${validationError}`, toolSteps, toolsUsed, stepMessages };
        }

        // Execute tool
        const tool = this.registry.getTool(parsed.tool)!;
        logger.info('tool-loop: executing tool', { tool: parsed.tool, input: parsed.input, step });

        let toolResult: string;
        try {
          toolResult = await tool.run(parsed.input);
        } catch (e) {
          toolResult = `Tool execution failed: ${String(e)}`;
          logger.warn('tool-loop: tool error', { tool: parsed.tool, error: String(e) });
        }

        toolsUsed.push(parsed.tool);
        toolSteps++;

        // Inject tool result back into message history and loop
        const assistantMsg = createMessage({ role: 'assistant', content: llmText });
        const toolResultMsg = buildToolResultMessage(parsed.tool, toolResult);
        currentMessages = [...currentMessages, assistantMsg, toolResultMsg];

        logger.debug('tool-loop: result injected, continuing', { tool: parsed.tool, step });
        continue;
      }

      // Case 2: LLM returned a structured final response
      if (parsed?.type === 'final_response') {
        logger.debug('tool-loop: structured final_response', { step, toolSteps });
        return { finalText: parsed.content, toolSteps, toolsUsed, stepMessages };
      }

      // Case 3: Plain text (no JSON — treat as final answer)
      logger.debug('tool-loop: plain text final response', { step, toolSteps });
      return { finalText: llmText, toolSteps, toolsUsed, stepMessages };
    }

    // Unreachable — but TypeScript needs this
    return { finalText: '', toolSteps, toolsUsed, stepMessages };
  }
}
