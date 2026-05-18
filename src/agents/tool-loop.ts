/**
 * agents/tool-loop.ts
 * Multi-step LLM ↔ Tool execution loop.
 */

import type { IProvider } from '../types/provider';
import type { Message } from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { ToolRegistry, RegisteredTool } from '../tools/tool-registry';
import { parseLLMResponse, validateToolCall } from './tool-parser';
import { createLogger } from '../utils/logger';

const logger = createLogger('agents:tool-loop');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolLoopOptions {
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  preferredTool?: string | null;
  enableRepair?: boolean;
  maxRepairAttempts?: number;
}

export interface ToolLoopResult {
  finalText: string;
  toolSteps: number;
  toolsUsed: string[];
  stepMessages: Message[];
  flow: Array<Record<string, unknown>>;
}

// ─── Structured parsing types ────────────────────────────────────────────────

type ParsedStructuredResponse =
  | { type: 'tool_call'; tool: string; input: unknown }
  | { type: 'final_response'; content: string }
  | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripMarkdownFences(text: string): string {
  return text.replace(/```json/gi, '').replace(/```/g, '').trim();
}

const INTERNAL_XML_BLOCK_RE = /<(reasoning|analysis|thought|plan)\b[^>]*>[\s\S]*?<\/\1>/gi;
const INTERNAL_HEADING_RE = /^(#{1,6}\s*)?(reasoning|thought|analysis|plan|decision|observation|action|tool call|internal reasoning)\s*:?\s*$/i;
const ANSWER_HEADING_RE = /^#{1,6}\s*(final answer|answer|jawaban)\s*:?\s*$/i;
const INTERNAL_LINE_RE = /^(?:[-*]\s*)?(?:the user is asking|user is asking|the user asks|from the memory|based on memory|i should answer|i need to answer|i need to|reasoning:|thought:|analysis:|plan:|decision:|observation:|action:|tool call:|internal reasoning:|i will use|i should use)\b/i;
const FINAL_LABEL_RE = /^(?:final answer|answer|jawaban)\s*:\s*/i;

function removeInternalHeadingBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let droppingInternalSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (INTERNAL_HEADING_RE.test(trimmed)) {
      droppingInternalSection = true;
      continue;
    }

    if (droppingInternalSection) {
      if (/^#{1,6}\s+\S/.test(trimmed) && !INTERNAL_HEADING_RE.test(trimmed)) {
        droppingInternalSection = false;
        if (!ANSWER_HEADING_RE.test(trimmed)) kept.push(line);
      }
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n');
}

export function sanitizeFinalAnswer(text: string): string {
  const original = text.trim();
  if (!original) return original;

  let cleaned = original
    .replace(INTERNAL_XML_BLOCK_RE, '')
    .trim();

  cleaned = removeInternalHeadingBlocks(cleaned).trim();

  const lines = cleaned.split(/\r?\n/);
  let start = 0;

  while (start < lines.length) {
    const trimmed = lines[start]?.trim() ?? '';
    if (!trimmed || INTERNAL_LINE_RE.test(trimmed)) {
      start++;
      continue;
    }
    break;
  }

  cleaned = lines
    .slice(start)
    .join('\n')
    .replace(FINAL_LABEL_RE, '')
    .trim();

  return cleaned || original;
}

function toolLoopResult(result: ToolLoopResult): ToolLoopResult {
  return {
    ...result,
    finalText: sanitizeFinalAnswer(result.finalText),
  };
}

function extractBalancedJsonCandidate(text: string): string | null {
  const cleaned = stripMarkdownFences(text);

  const fenceMatch = /```(?:json|js|javascript)?\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');
  const start =
    firstObject === -1
      ? firstArray
      : firstArray === -1
        ? firstObject
        : Math.min(firstObject, firstArray);

  if (start === -1) return null;
  return cleaned.slice(start).trim();
}

function safeJsonParse(text: string): unknown | null {
  const candidate = extractBalancedJsonCandidate(text);
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStructuredResponse(raw: unknown, availableTools: string[]): ParsedStructuredResponse {
  if (!isPlainObject(raw)) return null;

  const rawType = asString(raw['type']);
  const rawTool = asString(raw['tool']);
  const rawContent =
    asString(raw['content']) ??
    asString(raw['answer']) ??
    asString(raw['final']) ??
    asString(raw['response']);

  const rawInput =
    raw['input'] ?? raw['arguments'] ?? raw['args'] ??
    raw['params'] ?? raw['parameters'] ?? raw['payload'] ?? undefined;

  if (rawType === 'final_response') {
    return { type: 'final_response', content: rawContent ?? '' };
  }
  if (rawType === 'tool_call' && rawTool) {
    return { type: 'tool_call', tool: rawTool, input: rawInput ?? {} };
  }
  if (rawTool) {
    return { type: 'tool_call', tool: rawTool, input: rawInput ?? {} };
  }
  if (rawType && availableTools.includes(rawType)) {
    return { type: 'tool_call', tool: rawType, input: rawInput ?? {} };
  }
  if (rawContent) {
    return { type: 'final_response', content: rawContent };
  }
  return null;
}

function parseStructuredResponse(llmText: string, availableTools: string[]): ParsedStructuredResponse {
  const cleaned = stripMarkdownFences(llmText);

  try {
    const parsed = parseLLMResponse(cleaned) as unknown;
    const normalized = normalizeStructuredResponse(parsed, availableTools);
    if (normalized) return normalized;
  } catch (e) {
    logger.debug('tool-loop: primary parser failed, falling back', { error: String(e) });
  }

  const raw = safeJsonParse(cleaned);
  if (raw !== null) {
    const normalized = normalizeStructuredResponse(raw, availableTools);
    if (normalized) return normalized;
  }

  return null;
}

function looksLikeStructuredToolCall(text: string, availableTools: string[]): boolean {
  const cleaned = stripMarkdownFences(text).toLowerCase();
  if (
    cleaned.includes('"tool"') ||
    cleaned.includes('"type":"tool_call"') ||
    cleaned.includes('"input"')
  ) return true;
  for (const tool of availableTools) {
    if (cleaned.includes(`"type":"${tool.toLowerCase()}"`)) return true;
    if (cleaned.includes(`"tool":"${tool.toLowerCase()}"`)) return true;
  }
  return false;
}

function buildToolResultMessage(toolName: string, result: string): Message {
  return createMessage({
    role: 'user',
    content:
      `TOOL RESULT [${toolName}]:\n\n${result}\n\n` +
      `Based on the above tool result, provide your final answer to the user.`,
  });
}

function buildStrictToolContractBlock(
  availableTools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  preferredTool?: string | null
): string {
  const lines: string[] = [];
  lines.push('TOOL CONTRACT', '');
  lines.push('When a tool is needed, respond with ONLY valid JSON in one of these forms:', '');
  lines.push('1) Canonical tool call:');
  lines.push('{', '  "type": "tool_call",', '  "tool": "<tool-name>",', '  "input": { ... }', '}', '');
  lines.push('2) Final response:');
  lines.push('{', '  "type": "final_response",', '  "content": "..."', '}', '');
  lines.push('Rules:');
  lines.push('- Do not wrap JSON in markdown fences.');
  lines.push('- Do not add explanations outside JSON.');
  lines.push('- Do not output any keys other than type/tool/input/content.');
  if (preferredTool) lines.push(`- Preferred tool hint: ${preferredTool}`);
  lines.push('');

  if (availableTools.length > 0) {
    lines.push('AVAILABLE TOOLS');
    for (const tool of availableTools) {
      lines.push('', `Tool: ${tool.name}`);
      if (tool.description) lines.push(`Description: ${tool.description}`);
      if (tool.inputSchema !== undefined) {
        try { lines.push(`Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}`); }
        catch { lines.push('Input schema: [unserializable]'); }
      }
    }
  }
  return lines.join('\n');
}

function appendToolContractToSystemPrompt(
  systemPrompt: string,
  toolBlock: string,
  preferredTool?: string | null,
  repairMode?: boolean
): string {
  const parts = [systemPrompt.trim()];
  if (preferredTool) parts.push(`Preferred tool from reasoning engine: ${preferredTool}`);
  if (repairMode) {
    parts.push(
      'Your previous response was not valid tool-call JSON.\nRetry using valid JSON only.\nReturn ONLY one JSON object.\nDo not wrap in markdown fences.'
    );
  }
  parts.push(toolBlock.trim());
  return parts.filter(Boolean).join('\n\n');
}

function buildRepairPrompt(invalidText: string, availableTools: string[]): string {
  return [
    'The previous output was invalid for tool execution.',
    '',
    'You MUST return ONLY valid JSON matching one of these formats:',
    '{ "type": "tool_call", "tool": "<tool-name>", "input": { ... } }',
    '{ "type": "final_response", "content": "..." }',
    '',
    'Important rules:',
    '- Use only one JSON object.',
    '- Do not wrap in markdown fences.',
    '- Do not include prose before or after JSON.',
    '- If you want to call a tool, the tool name must be one of:',
    `  ${availableTools.join(', ') || '(none)'}`,
    '',
    'Your invalid output was:',
    invalidText,
  ].join('\n');
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
      preferredTool: opts.preferredTool ?? null,
      enableRepair: opts.enableRepair ?? true,
      maxRepairAttempts: opts.maxRepairAttempts ?? 2,
    };
  }

  async run(
    provider: IProvider,
    model: string,
    messages: Message[],
    systemPrompt: string,
    signal?: AbortSignal
  ): Promise<ToolLoopResult> {
    // FIX: use conditional spread so optional fields are never explicitly `undefined`
    // (required by exactOptionalPropertyTypes — absent key ≠ key set to undefined)
    const toolEntries = this.registry.listTools().map((t: RegisteredTool) => ({
      name: t.manifest.name,
      ...(t.manifest.description !== undefined && { description: t.manifest.description }),
      ...(t.manifest.inputSchema !== undefined && { inputSchema: t.manifest.inputSchema as unknown }),
    }));

    const availableTools = toolEntries.map((t) => t.name);
    const stepMessages: Message[] = [];
    const toolsUsed: string[] = [];
    const flow: Array<Record<string, unknown>> = [];
    let toolSteps = 0;
    let repairAttempts = 0;
    let currentMessages = [...messages];

    for (let step = 0; step <= this.opts.maxSteps; step++) {
      const isLastStep = step === this.opts.maxSteps;
      const toolContractBlock = buildStrictToolContractBlock(
        toolEntries,
        this.opts.preferredTool
      );

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
        step,
        model,
        messageCount: currentMessages.length,
        toolSteps,
        preferredTool: this.opts.preferredTool,
      });

      // FIX: extractText imported at top — no inline require
      let llmText: string;
      try {
        const response = await provider.chat({
          model,
          messages: currentMessages,
          systemPrompt: appendToolContractToSystemPrompt(
            systemPrompt,
            toolContractBlock,
            this.opts.preferredTool
          ),
          temperature: this.opts.temperature,
          maxTokens: this.opts.maxTokens,
          ...(signal !== undefined && { signal }),
        });
        llmText = extractText(response.message.content);
      } catch (e) {
        const errMsg = `LLM call failed at step ${step}: ${String(e)}`;
        logger.warn(errMsg);
        return toolLoopResult({ finalText: `❌ ${errMsg}`, toolSteps, toolsUsed, stepMessages, flow });
      }

      stepMessages.push(createMessage({ role: 'assistant', content: llmText }));
      const parsed = parseStructuredResponse(llmText, availableTools);

      if (parsed?.type === 'tool_call') {
        if (isLastStep) {
          const validationError = validateToolCall(parsed, availableTools);
          if (validationError) {
            logger.warn('tool-loop: invalid tool call at max step', { error: validationError, modelOutput: llmText });
            return toolLoopResult({ finalText: `❌ ${validationError}`, toolSteps, toolsUsed, stepMessages, flow });
          }

          // FIX: getTool returns RegisteredTool | undefined — no 'as any'
          const tool: RegisteredTool | undefined = this.registry.getTool(parsed.tool);
          if (!tool) {
            return toolLoopResult({ finalText: `❌ Tool "${parsed.tool}" was requested but is not available.`, toolSteps, toolsUsed, stepMessages, flow });
          }

          let toolResult: string;
          try {
            flow.push({ stage: 'tool_call', tool: parsed.tool, input: parsed.input ?? {} });
            toolResult = await tool.run(parsed.input ?? {});
          } catch (e) {
            toolResult = `Tool execution failed: ${String(e)}`;
            logger.warn('tool-loop: tool error on final step', { tool: parsed.tool, error: String(e) });
          }
          toolsUsed.push(parsed.tool);
          toolSteps++;
          flow.push({ stage: 'tool_result', tool: parsed.tool, ok: !toolResult.startsWith('Tool execution failed:') });
          return toolLoopResult({ finalText: toolResult, toolSteps, toolsUsed, stepMessages, flow });
        }

        const validationError = validateToolCall(parsed, availableTools);
        if (validationError) {
          logger.warn('tool-loop: invalid tool call', { error: validationError, modelOutput: llmText });
          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;
            currentMessages = [...currentMessages, createMessage({ role: 'user', content: buildRepairPrompt(llmText, availableTools) })];
            logger.debug('tool-loop: repair retry queued', { repairAttempts, step });
            continue;
          }
          return toolLoopResult({ finalText: `❌ ${validationError}`, toolSteps, toolsUsed, stepMessages, flow });
        }

        // FIX: no 'as any' — proper type
        const tool: RegisteredTool | undefined = this.registry.getTool(parsed.tool);
        if (!tool) {
          const errMsg = `Tool "${parsed.tool}" is not registered.`;
          logger.warn('tool-loop: tool missing', { tool: parsed.tool });
          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;
            currentMessages = [...currentMessages, createMessage({ role: 'user', content: buildRepairPrompt(`Requested unavailable tool: ${parsed.tool}\n\n${llmText}`, availableTools) })];
            continue;
          }
          return toolLoopResult({ finalText: `❌ ${errMsg}`, toolSteps, toolsUsed, stepMessages, flow });
        }

        logger.info('tool-loop: executing tool', { tool: parsed.tool, input: parsed.input, step });
        let toolResult: string;
        try {
          flow.push({ stage: 'tool_call', tool: parsed.tool, input: parsed.input ?? {} });
          toolResult = await tool.run(parsed.input ?? {});
        } catch (e) {
          toolResult = `Tool execution failed: ${String(e)}`;
          logger.warn('tool-loop: tool error', { tool: parsed.tool, error: String(e) });
        }
        toolsUsed.push(parsed.tool);
        toolSteps++;
        flow.push({ stage: 'tool_result', tool: parsed.tool, ok: !toolResult.startsWith('Tool execution failed:') });

        const assistantMsg = createMessage({ role: 'assistant', content: llmText });
        const toolResultMsg = buildToolResultMessage(parsed.tool, toolResult);
        currentMessages = [...currentMessages, assistantMsg, toolResultMsg];
        logger.debug('tool-loop: result injected, continuing', { tool: parsed.tool, step, toolSteps });
        continue;
      }

      if (parsed?.type === 'final_response') {
        logger.debug('tool-loop: structured final_response', { step, toolSteps });
        return toolLoopResult({ finalText: parsed.content.trim() || llmText, toolSteps, toolsUsed, stepMessages, flow });
      }

      if (looksLikeStructuredToolCall(llmText, availableTools)) {
        logger.warn('tool-loop: structured output detected but parse failed', { step, repairAttempts, modelOutput: llmText });
        if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
          repairAttempts++;
          currentMessages = [...currentMessages, createMessage({ role: 'user', content: buildRepairPrompt(llmText, availableTools) })];
          continue;
        }
        return toolLoopResult({
          finalText: '❌ The model produced a tool-call-like response, but it could not be parsed safely.',
          toolSteps, toolsUsed, stepMessages, flow,
        });
      }

      logger.debug('tool-loop: plain text final response', { step, toolSteps });
      return toolLoopResult({ finalText: llmText, toolSteps, toolsUsed, stepMessages, flow });
    }

    return toolLoopResult({ finalText: '', toolSteps, toolsUsed, stepMessages, flow });
  }
}
