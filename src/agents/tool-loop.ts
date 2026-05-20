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

const TOOL_ALIASES: Record<string, string> = {
  news_api: 'web-fetch',
  news: 'web-fetch',
  web_news: 'web-fetch',
  web_search: 'web-fetch',
  search: 'web-fetch',
  browser: 'web-fetch',
  browse: 'web-fetch',
  internet: 'web-fetch',
  internet_search: 'web-fetch',
  current_info: 'web-fetch',
  latest_info: 'web-fetch',
};

const NO_TOOLS_MESSAGE =
  'Tool execution is currently unavailable because no tools are loaded. Please check that the app is running from the project root and that tools/installed contains enabled tool manifests.';

const CURRENT_INFO_EMAIL_RE = /(hari ini|terbaru|current|latest|today|news|berita|harga|price|emas|gold|market|pasar)/i;
const EMAIL_INTENT_RE = /\b(email|mail)\b|kirim\s+email|send\s+email/i;

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
const INTERNAL_HEADING_RE = /^(#{1,6}\s*)?(reasoning|thought|analysis|analisis|plan|decision|observation|action|tool call|internal reasoning)\s*:?\s*$/i;
const ANSWER_HEADING_RE = /^#{1,6}\s*(final answer|answer|jawaban)\s*:?\s*$/i;
const INTERNAL_LINE_RE = /^(?:[-*]\s*)?(?:the user is asking|user is asking|the user asks|from the memory|based on memory|i should answer|i need to answer|i need to|reasoning:|thought:|analysis:|analisis:|plan:|decision:|observation:|action:|tool call:|internal reasoning:|i will use|i should use)(?:\b|\s|$)/i;
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
  if (!original) return text;

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

export function normalizeToolName(toolName: string, availableTools: string[]): string {
  const trimmed = toolName.trim();
  if (availableTools.includes(trimmed)) return trimmed;

  const exactCaseInsensitive = availableTools.find(
    (tool) => tool.toLowerCase() === trimmed.toLowerCase()
  );
  if (exactCaseInsensitive) return exactCaseInsensitive;

  const aliasTarget = TOOL_ALIASES[trimmed.toLowerCase()];
  if (aliasTarget && availableTools.includes(aliasTarget)) return aliasTarget;

  return toolName;
}

function normalizeParsedToolCall(
  parsed: { type: 'tool_call'; tool: string; input: unknown },
  availableTools: string[]
): { type: 'tool_call'; tool: string; input: unknown } {
  const normalizedTool = normalizeToolName(parsed.tool, availableTools);
  if (normalizedTool !== parsed.tool) {
    logger.info('tool-loop: normalized tool alias', {
      from: parsed.tool,
      to: normalizedTool,
    });
  }
  return normalizedTool === parsed.tool ? parsed : { ...parsed, tool: normalizedTool };
}

function isPlaceholderEmail(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return lower.endsWith('@example.com') ||
    ['email@example.com', 'recipient@example.com', 'test@example.com'].includes(lower);
}

function isPlaceholderName(value: string): boolean {
  return [
    'nama penerima',
    'nama pengirim',
    'recipient name',
    'sender name',
    'test user',
    'example user',
  ].includes(value.trim().toLowerCase());
}

function normalizeBrevoToolInput(input: unknown): unknown {
  if (!isPlainObject(input)) return input;

  const cleaned: Record<string, unknown> = { ...input };
  for (const key of ['recipientEmail', 'senderEmail']) {
    const value = cleaned[key];
    if (typeof value === 'string' && isPlaceholderEmail(value)) delete cleaned[key];
  }
  for (const key of ['recipientName', 'senderName']) {
    const value = cleaned[key];
    if (typeof value === 'string' && isPlaceholderName(value)) delete cleaned[key];
  }
  return cleaned;
}

function normalizeToolCallInput(
  toolCall: { type: 'tool_call'; tool: string; input: unknown }
): { type: 'tool_call'; tool: string; input: unknown } {
  if (toolCall.tool !== 'brevo-email') return toolCall;
  return { ...toolCall, input: normalizeBrevoToolInput(toolCall.input) };
}

function originalUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'user') return extractText(message.content);
  }
  return '';
}

function shouldFetchBeforeBrevoEmail(messages: Message[], availableTools: string[], toolsUsed: string[]): boolean {
  if (!availableTools.includes('web-fetch')) return false;
  if (toolsUsed.includes('web-fetch')) return false;
  const text = originalUserText(messages);
  return EMAIL_INTENT_RE.test(text) && CURRENT_INFO_EMAIL_RE.test(text);
}

function brevoFinalAnswer(toolResult: string): string {
  const parsed = safeJsonParse(toolResult);
  if (isPlainObject(parsed)) {
    const ok = parsed['ok'] === true;
    const content = typeof parsed['content'] === 'string' ? parsed['content'] : '';
    const recipient = typeof parsed['recipientEmail'] === 'string' ? parsed['recipientEmail'] : '';
    const messageId = typeof parsed['messageId'] === 'string' ? parsed['messageId'] : '';
    const status = typeof parsed['status'] === 'number' ? ` HTTP ${parsed['status']}.` : '';
    const error = typeof parsed['error'] === 'string' ? parsed['error'] : '';

    if (ok) {
      const target = recipient ? ` ke ${recipient}` : '';
      const idText = messageId ? ` Message ID: ${messageId}.` : '';
      return `Email berhasil dikirim${target}.${idText}`;
    }

    const detail = content || error || 'Brevo tidak mengonfirmasi pengiriman.';
    return `Email gagal dikirim.${status} ${detail}`.trim();
  }

  if (/not sent|failed|error|missing/i.test(toolResult)) {
    return `Email gagal dikirim. ${toolResult}`;
  }
  if (/sent/i.test(toolResult)) {
    return `Email berhasil dikirim. ${toolResult}`;
  }
  return toolResult;
}

function toolResultOk(toolName: string, toolResult: string): boolean {
  if (toolName !== 'brevo-email') return !toolResult.startsWith('Tool execution failed:');
  const parsed = safeJsonParse(toolResult);
  if (isPlainObject(parsed) && typeof parsed['ok'] === 'boolean') return parsed['ok'];
  return /^Brevo email sent/i.test(toolResult);
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
  lines.push('- Use ONLY exact tool names listed in AVAILABLE TOOLS.');
  lines.push('- Do not invent tool names.');
  lines.push('- Never use news_api, news, search_api, web_search, browser, or browse unless that exact name appears in AVAILABLE TOOLS.');
  lines.push('- If no suitable tool exists, return a final_response explaining that the capability is unavailable.');
  lines.push('- Tool call output must use the exact registered tool name.');
  lines.push('- Do not wrap JSON in markdown fences.');
  lines.push('- Do not add explanations outside JSON.');
  lines.push('- Do not output any keys other than type/tool/input/content.');
  if (availableTools.some((tool) => tool.name === 'web-fetch')) {
    lines.push('- For news, latest information, current events, current prices, online lookup, or web search, use web-fetch.');
    lines.push('- Example for real-time internet/news/current information:');
    lines.push('{ "type": "tool_call", "tool": "web-fetch", "input": { "query": "latest news today" } }');
  }
  if (availableTools.some((tool) => tool.name === 'brevo-email')) {
    lines.push('- For brevo-email: do not invent recipientEmail, senderEmail, recipientName, or senderName.');
    lines.push('- If the user does not explicitly provide a recipient, omit recipientEmail and recipientName; brevo-email will use BREVO_RECIPIENT_EMAIL and BREVO_RECIPIENT_NAME.');
    lines.push('- Never use email@example.com, recipient@example.com, test@example.com, @example.com emails, "Nama Penerima", or other placeholders.');
    lines.push('- Never claim the email was sent unless brevo-email returns ok=true.');
    lines.push('- If brevo-email returns ok=false, tell the user the send failed and summarize the safe error detail.');
    lines.push('- For email about current prices, today, latest news, or market updates: call web-fetch first when available, then call brevo-email using the fetched information.');
  }
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
    let brevoWebFetchDone = false;

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
        if (availableTools.length === 0) {
          logger.warn('tool-loop: no tools available for requested tool call', {
            requestedTool: parsed.tool,
          });
          return toolLoopResult({
            finalText: NO_TOOLS_MESSAGE,
            toolSteps,
            toolsUsed,
            stepMessages,
            flow,
          });
        }

        const toolCall = normalizeToolCallInput(normalizeParsedToolCall(parsed, availableTools));

        if (
          toolCall.tool === 'brevo-email' &&
          shouldFetchBeforeBrevoEmail(messages, availableTools, toolsUsed)
        ) {
          const webTool = this.registry.getTool('web-fetch');
          if (webTool) {
            const query = originalUserText(messages);
            logger.info('tool-loop: fetching real-time data before brevo-email', { query });
            let webResult: string;
            try {
              flow.push({ stage: 'tool_call', tool: 'web-fetch', input: { query } });
              webResult = await webTool.run({ query });
            } catch (e) {
              webResult = `Tool execution failed: ${String(e)}`;
              logger.warn('tool-loop: web-fetch before email failed', { error: String(e) });
            }
            toolsUsed.push('web-fetch');
            toolSteps++;
            const webFetchOk = !webResult.startsWith('Tool execution failed:');
            if (webFetchOk) {
              brevoWebFetchDone = true;
            }
            flow.push({ stage: 'tool_result', tool: 'web-fetch', ok: webFetchOk });
            currentMessages = [
              ...currentMessages,
              createMessage({
                role: 'user',
                content:
                  `TOOL RESULT [web-fetch]:\n\n${webResult}\n\n` +
                  'INSTRUCTION: You MUST now call brevo-email tool with the above information. ' +
                  'Return ONLY this JSON — do NOT return a final_response:\n' +
                  '{"type":"tool_call","tool":"brevo-email","input":{"subject":"<subject>","htmlContent":"<html>"}}\n' +
                  'Do NOT invent recipientEmail or senderEmail. Use only subject and htmlContent.',
              }),
            ];
            continue;
          }
        }

        if (isLastStep) {
          const validationError = validateToolCall(toolCall, availableTools);
          if (validationError) {
            logger.warn('tool-loop: invalid tool call at max step', { error: validationError, modelOutput: llmText });
            return toolLoopResult({ finalText: `Tool execution failed: ${validationError}`, toolSteps, toolsUsed, stepMessages, flow });
          }

          // FIX: getTool returns RegisteredTool | undefined — no 'as any'
          const tool: RegisteredTool | undefined = this.registry.getTool(toolCall.tool);
          if (!tool) {
            return toolLoopResult({
              finalText: `Tool "${toolCall.tool}" was requested but is not available.`,
              toolSteps,
              toolsUsed,
              stepMessages,
              flow,
            });
          }

          let toolResult: string;
          try {
            flow.push({ stage: 'tool_call', tool: toolCall.tool, input: toolCall.input ?? {} });
            toolResult = await tool.run(toolCall.input ?? {});
          } catch (e) {
            toolResult = `Tool execution failed: ${String(e)}`;
            logger.warn('tool-loop: tool error on final step', { tool: toolCall.tool, error: String(e) });
          }
          toolsUsed.push(toolCall.tool);
          toolSteps++;
          flow.push({ stage: 'tool_result', tool: toolCall.tool, ok: toolResultOk(toolCall.tool, toolResult) });
          return toolLoopResult({
            finalText: toolCall.tool === 'brevo-email' ? brevoFinalAnswer(toolResult) : toolResult,
            toolSteps,
            toolsUsed,
            stepMessages,
            flow,
          });
        }

        const validationError = validateToolCall(toolCall, availableTools);
        if (validationError) {
          logger.warn('tool-loop: invalid tool call', { error: validationError, modelOutput: llmText });
          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;
            currentMessages = [...currentMessages, createMessage({ role: 'user', content: buildRepairPrompt(llmText, availableTools) })];
            logger.debug('tool-loop: repair retry queued', { repairAttempts, step });
            continue;
          }
          return toolLoopResult({ finalText: `Tool execution failed: ${validationError}`, toolSteps, toolsUsed, stepMessages, flow });
        }

        // FIX: no 'as any' — proper type
        const tool: RegisteredTool | undefined = this.registry.getTool(toolCall.tool);
        if (!tool) {
          const errMsg = `Tool "${toolCall.tool}" is not registered.`;
          logger.warn('tool-loop: tool missing', { tool: toolCall.tool });
          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;
            currentMessages = [...currentMessages, createMessage({ role: 'user', content: buildRepairPrompt(`Requested unavailable tool: ${toolCall.tool}\n\n${llmText}`, availableTools) })];
            continue;
          }
          return toolLoopResult({ finalText: errMsg, toolSteps, toolsUsed, stepMessages, flow });
        }

        logger.info('tool-loop: executing tool', { tool: toolCall.tool, input: toolCall.input, step });
        let toolResult: string;
        try {
          flow.push({ stage: 'tool_call', tool: toolCall.tool, input: toolCall.input ?? {} });
          toolResult = await tool.run(toolCall.input ?? {});
        } catch (e) {
          toolResult = `Tool execution failed: ${String(e)}`;
          logger.warn('tool-loop: tool error', { tool: toolCall.tool, error: String(e) });
        }
        toolsUsed.push(toolCall.tool);
        toolSteps++;
        flow.push({ stage: 'tool_result', tool: toolCall.tool, ok: toolResultOk(toolCall.tool, toolResult) });

        if (toolCall.tool === 'brevo-email') {
          return toolLoopResult({
            finalText: brevoFinalAnswer(toolResult),
            toolSteps,
            toolsUsed,
            stepMessages,
            flow,
          });
        }

        const assistantMsg = createMessage({ role: 'assistant', content: llmText });
        const toolResultMsg = buildToolResultMessage(toolCall.tool, toolResult);
        currentMessages = [...currentMessages, assistantMsg, toolResultMsg];
        logger.debug('tool-loop: result injected, continuing', { tool: toolCall.tool, step, toolSteps });
        continue;
      }

      if (parsed?.type === 'final_response') {
        if (brevoWebFetchDone && availableTools.includes('brevo-email')) {
          logger.warn('tool-loop: LLM returned final_response after brevo web-fetch pre-fetch', { step });
        }
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
