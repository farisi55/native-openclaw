/**
 * agents/tool-parser.ts
 * Robust parser for model-emitted tool calls and structured responses.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('agents:tool-parser');

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface ParsedToolExecution {
  type: 'tool_call';
  tool: string;
  input: unknown;
}

export interface ParsedFinalResponse {
  type: 'final_response';
  content: string;
}

export type ParsedLLMResponse =
  | ParsedToolExecution
  | ParsedFinalResponse;

export type ParsedToolCall = ParsedLLMResponse;

type AnyRecord = Record<string, unknown>;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function safeParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is AnyRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0
    ? v.trim()
    : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main parser
// ──────────────────────────────────────────────────────────────────────────────

export function parseLLMResponse(
  text: string
): ParsedLLMResponse | null {
  if (!text || !text.trim()) {
    return null;
  }

  const cleaned = stripMarkdown(text);

  // ─── Direct parse ─────────────────────────────────────────────────────────

  let parsed = safeParse(cleaned);

  // ─── Recovery parse ───────────────────────────────────────────────────────

  if (!parsed) {
    const match = cleaned.match(/\{[\s\S]*\}/);

    if (match?.[0]) {
      parsed = safeParse(match[0]);
    }
  }

  if (!isObject(parsed)) {
    logger.debug('parser: not valid json');
    return null;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // FINAL RESPONSE
  // ──────────────────────────────────────────────────────────────────────────

  if (parsed.type === 'final_response') {
    return {
      type: 'final_response',
      content:
        asString(parsed.content) ??
        asString(parsed.answer) ??
        asString(parsed.response) ??
        '',
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // CANONICAL TOOL CALL
  // { "type":"tool_call","tool":"x","input":{} }
  // ──────────────────────────────────────────────────────────────────────────

  if (
    parsed.type === 'tool_call' &&
    asString(parsed.tool)
  ) {
    return {
      type: 'tool_call',
      tool: asString(parsed.tool)!,
      input: parsed.input ?? {},
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LEGACY FORMAT
  // { "tool":"web-fetch","input":{} }
  // ──────────────────────────────────────────────────────────────────────────

  if (asString(parsed.tool)) {
    return {
      type: 'tool_call',
      tool: asString(parsed.tool)!,
      input: parsed.input ?? {},
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TYPE-AS-TOOL FORMAT
  // { "type":"web-fetch","input":{} }
  // ──────────────────────────────────────────────────────────────────────────

  if (
    parsed.type &&
    typeof parsed.type === 'string' &&
    parsed.type !== 'final_response'
  ) {
    return {
      type: 'tool_call',
      tool: parsed.type,
      input: parsed.input ?? {},
    };
  }

  logger.debug('parser: unsupported json shape');

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────────────────────────────

export function validateToolCall(
  parsed: ParsedLLMResponse,
  availableTools: string[]
): string | null {
  if (parsed.type !== 'tool_call') {
    return null;
  }

  if (!parsed.tool || !parsed.tool.trim()) {
    return 'Missing tool name.';
  }

  if (!availableTools.includes(parsed.tool)) {
    return `Tool "${parsed.tool}" is not registered. Available tools: ${availableTools.join(', ')}`;
  }

  if (
    parsed.input !== undefined &&
    typeof parsed.input !== 'object'
  ) {
    return 'Tool input must be an object.';
  }

  return null;
}