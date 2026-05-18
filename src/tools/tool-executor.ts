/**
 * tools/tool-executor.ts
 * v7: LLM-driven execution only. Rule-based keyword matching removed.
 *
 * Responsibilities:
 *   - tryRuleBased()   → kept as fast-path for deterministic inputs only
 *   - tryLLMAssisted() → parse LLM response for tool calls (legacy compat)
 *   - execute()        → direct tool execution given parsed call
 */

import type { ToolRegistry } from './tool-registry';
import { parseLLMResponse, validateToolCall } from '../agents/tool-parser';
import { normalizeToolName } from '../agents/tool-loop';
import { createLogger } from '../utils/logger';

const logger = createLogger('tools:executor');

export interface ToolExecutionResult {
  handled: boolean;
  response?: string;
  toolName?: string | undefined;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Fallback rule-based matching (kept only for deterministic fast-path cases
   * when tools block is not in the system prompt). Removed keyword hardcoding.
   */
  async tryRuleBased(userInput: string): Promise<ToolExecutionResult> {
    const tool = this.registry.findByTrigger(userInput);
    if (!tool) return { handled: false };

    logger.info('tool triggered (rule-based fallback)', { tool: tool.manifest.name });
    try {
      const response = await tool.run({ query: userInput });
      return { handled: true, response, toolName: tool.manifest.name };
    } catch (e) {
      return {
        handled: true,
        response: `❌ Tool "${tool.manifest.name}" failed: ${String(e)}`,
        toolName: tool.manifest.name,
      };
    }
  }

  /**
   * Parse an LLM response for a tool call and execute it.
   * Used for single-step (non-loop) execution in legacy paths.
   */
  async tryLLMAssisted(llmResponse: string): Promise<ToolExecutionResult> {
    const parsed = parseLLMResponse(llmResponse);
    if (!parsed || parsed.type !== 'tool_call') return { handled: false };

    const availableTools = this.registry.listTools().map((t) => t.manifest.name);
    const normalizedTool = normalizeToolName(parsed.tool, availableTools);
    if (normalizedTool !== parsed.tool) {
      logger.info('LLM-assisted: normalized tool alias', {
        from: parsed.tool,
        to: normalizedTool,
      });
    }
    const toolCall = { ...parsed, tool: normalizedTool };
    const validationError = validateToolCall(toolCall, availableTools);
    if (validationError) {
      logger.warn('LLM-assisted: invalid tool call', { error: validationError });
      return { handled: false };
    }

    const tool = this.registry.getTool(toolCall.tool);
    if (!tool) return { handled: false };

    logger.info('tool triggered (LLM-assisted)', { tool: toolCall.tool, input: toolCall.input });
    try {
      const response = await tool.run(toolCall.input);
      return { handled: true, response, toolName: toolCall.tool };
    } catch (e) {
      return {
        handled: true,
        response: `❌ Tool "${toolCall.tool}" failed: ${String(e)}`,
        toolName: toolCall.tool,
      };
    }
  }

  /**
   * Directly execute a tool by name with given input.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      return { handled: false };
    }
    try {
      const response = await tool.run(input);
      return { handled: true, response, toolName };
    } catch (e) {
      return {
        handled: true,
        response: `❌ Tool "${toolName}" failed: ${String(e)}`,
        toolName,
      };
    }
  }
}

/** Re-export parseLLMToolCall as alias for backward compat */
export { parseLLMResponse as parseLLMToolCall } from '../agents/tool-parser';
