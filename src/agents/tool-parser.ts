/**
 * agents/tool-parser.ts
 * Parses LLM responses to extract structured tool calls or final responses.
 *
 * Supported LLM response formats:
 *
 * 1. Tool call (plain JSON):
 *    {"type":"tool_call","tool":"web-fetch","input":{"query":"AI news"}}
 *
 * 2. Final response (plain JSON):
 *    {"type":"final_response","content":"The answer is..."}
 *
 * 3. Tool call embedded in markdown fences:
 *    ```json
 *    {"type":"tool_call","tool":"system-time","input":{"query":"time"}}
 *    ```
 *
 * 4. Legacy format (backward compat from v6):
 *    {"tool":"web-fetch","input":{"query":"..."}}
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('agents:tool-parser');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedToolCall {
  type: 'tool_call';
  tool: string;
  input: Record<string, unknown>;
}

export interface ParsedFinalResponse {
  type: 'final_response';
  content: string;
}

export type ParsedLLMResponse = ParsedToolCall | ParsedFinalResponse | null;

// ─── Extraction helpers ───────────────────────────────────────────────────────

/** Extract the first JSON-looking block from text (handles markdown fences). */
function extractJsonCandidate(text: string): string | null {
  // 1. Markdown fence: ```json ... ``` or ``` ... ```
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(text);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // 2. Inline JSON block starting with { and containing "type" or "tool"
  // Use a balanced-brace extraction
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) return null;
  return text.slice(start, end + 1).trim();
}

// ─── Main parser ──────────────────────────────────────────────────────────────

/**
 * Parse an LLM response string and return a structured result.
 *
 * Returns:
 *   ParsedToolCall      — LLM wants to call a tool
 *   ParsedFinalResponse — LLM provided a direct answer
 *   null                — response is plain text (treat as final response)
 */
export function parseLLMResponse(llmText: string): ParsedLLMResponse {
  const trimmed = llmText.trim();
  if (!trimmed) return null;

  const candidate = extractJsonCandidate(trimmed);
  if (!candidate) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    logger.debug('JSON parse failed — plain text response', { snippet: candidate.slice(0, 60) });
    return null;
  }

  // New v7 format: {"type":"tool_call","tool":"...","input":{...}}
  if (parsed['type'] === 'tool_call') {
    const tool = parsed['tool'];
    const input = parsed['input'];
    if (typeof tool !== 'string' || !tool) {
      logger.warn('tool_call missing tool name', { parsed });
      return null;
    }
    return {
      type: 'tool_call',
      tool,
      input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>,
    };
  }

  // New v7 format: {"type":"final_response","content":"..."}
  if (parsed['type'] === 'final_response') {
    const content = parsed['content'];
    return {
      type: 'final_response',
      content: typeof content === 'string' ? content : trimmed,
    };
  }

  // Legacy v6 format: {"tool":"...","input":{...}}
  if (typeof parsed['tool'] === 'string') {
    const tool = parsed['tool'] as string;
    const input = parsed['input'];
    logger.debug('legacy tool call format detected', { tool });
    return {
      type: 'tool_call',
      tool,
      input: (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>,
    };
  }

  return null;
}

/**
 * Validate a parsed tool call against basic schema.
 * Returns an error string if invalid, null if valid.
 */
export function validateToolCall(
  call: ParsedToolCall,
  availableTools: string[]
): string | null {
  if (!availableTools.includes(call.tool)) {
    return `Tool "${call.tool}" is not available. Available: ${availableTools.join(', ')}`;
  }
  return null;
}
