/**
 * tools/tool-executor.ts
 * Smart tool execution engine combining:
 *   A) Rule-based trigger matching (instant, no LLM)
 *   B) LLM-assisted tool selection (parses JSON response from LLM)
 *
 * The orchestrator calls tryExecuteTool() before the LLM turn.
 * If no rule match, the tool list is injected into the system prompt
 * so the LLM can suggest a tool call in its response.
 */

import type { ToolRegistry } from './tool-registry';
import { createLogger } from '../utils/logger';

const logger = createLogger('tools:executor');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolExecutionResult {
  handled: boolean;
  response?: string;
  toolName?: string;
}

// ─── LLM tool call pattern ────────────────────────────────────────────────────

/**
 * Detects if an LLM response contains a tool call suggestion:
 * {"tool":"web-fetch","input":{"query":"latest news"}}
 */
// Matches {"tool":"name","input":{...}} with one level of nested braces
const TOOL_CALL_RE = /\{[^{}]*"tool"\s*:\s*"([^"]+)"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/;

export function parseLLMToolCall(
  llmResponse: string
): { tool: string; input: Record<string, unknown> } | null {
  const match = TOOL_CALL_RE.exec(llmResponse);
  if (!match) return null;
  try {
    const jsonStr = match[0];
    const parsed = JSON.parse(jsonStr) as { tool?: string; input?: Record<string, unknown> };
    if (typeof parsed.tool === 'string') {
      return { tool: parsed.tool, input: parsed.input ?? {} };
    }
  } catch {
    // JSON parse failed — not a tool call
  }
  return null;
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export class ToolExecutor {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Try to handle the user input via rule-based trigger matching.
   * Returns { handled: false } if no tool matches — caller should use LLM.
   */
  async tryRuleBased(userInput: string): Promise<ToolExecutionResult> {
    const tool = this.registry.findByTrigger(userInput);
    if (!tool) return { handled: false };

    logger.info('tool triggered (rule-based)', { tool: tool.manifest.name });

    try {
      const response = await tool.run({ query: userInput });
      return { handled: true, response, toolName: tool.manifest.name };
    } catch (e) {
      logger.warn('tool execution failed', { tool: tool.manifest.name, error: String(e) });
      return {
        handled: true,
        response: `❌ Tool "${tool.manifest.name}" failed: ${String(e)}`,
        toolName: tool.manifest.name,
      };
    }
  }

  /**
   * Try to execute a tool call suggested in an LLM response.
   * Called AFTER LLM responds if the response contains a JSON tool call.
   */
  async tryLLMAssisted(llmResponse: string): Promise<ToolExecutionResult> {
    const call = parseLLMToolCall(llmResponse);
    if (!call) return { handled: false };

    const tool = this.registry.getTool(call.tool);
    if (!tool) {
      logger.warn('LLM suggested unknown tool', { tool: call.tool });
      return { handled: false };
    }

    logger.info('tool triggered (LLM-assisted)', { tool: call.tool, input: call.input });

    try {
      const response = await tool.run(call.input);
      return { handled: true, response, toolName: call.tool };
    } catch (e) {
      return {
        handled: true,
        response: `❌ Tool "${call.tool}" failed: ${String(e)}`,
        toolName: call.tool,
      };
    }
  }
}
