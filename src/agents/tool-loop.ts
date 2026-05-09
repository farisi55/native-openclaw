/**
 * agents/tool-loop.ts
 * Multi-step LLM ↔ Tool execution loop.
 *
 * This version is intentionally more tolerant than a strict function-calling
 * parser:
 * - accepts multiple JSON shapes emitted by the model
 * - strips markdown fences
 * - normalizes legacy/ambiguous tool-call formats
 * - repairs invalid tool-call output with a bounded retry loop
 * - executes tools and re-injects observations for the next LLM step
 *
 * Supported model output shapes:
 * 1) {"type":"tool_call","tool":"web-fetch","input":{...}}
 * 2) {"tool":"web-fetch","input":{...}}
 * 3) {"type":"web-fetch","input":{...}}
 * 4) fenced JSON blocks with any of the above shapes
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

  /**
   * Optional preferred tool hint, typically coming from the reasoning engine.
   * Example: "web-fetch", "system-time", "api-client"
   */
  preferredTool?: string | null;

  /**
   * When the model emits invalid tool JSON, try to repair it by asking for a
   * stricter JSON-only retry. Default: true.
   */
  enableRepair?: boolean;

  /** Maximum repair retries when tool JSON is malformed. Default: 2. */
  maxRepairAttempts?: number;
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

// ─── Structured parsing types ────────────────────────────────────────────────

type ParsedStructuredResponse =
  | {
      type: 'tool_call';
      tool: string;
      input: unknown;
    }
  | {
      type: 'final_response';
      content: string;
    }
  | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripMarkdownFences(text: string): string {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function extractBalancedJsonCandidate(text: string): string | null {
  const cleaned = stripMarkdownFences(text);

  // Prefer the first fenced block if present.
  const fenceMatch = /```(?:json|js|javascript)?\s*([\s\S]*?)```/i.exec(text);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  // Otherwise try to find the first balanced object/array candidate.
  const firstObject = cleaned.indexOf('{');
  const firstArray = cleaned.indexOf('[');

  const start =
    firstObject === -1
      ? firstArray
      : firstArray === -1
        ? firstObject
        : Math.min(firstObject, firstArray);

  if (start === -1) return null;

  const candidate = cleaned.slice(start).trim();

  // If the model emitted extra prose around the JSON, this may still fail,
  // but it gives us a reasonable recovery path for common outputs.
  return candidate;
}

function safeJsonParse(text: string): unknown | null {
  const candidate = extractBalancedJsonCandidate(text);
  if (!candidate) return null;

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStructuredResponse(raw: unknown, availableTools: string[]): ParsedStructuredResponse {
  if (!isPlainObject(raw)) return null;

  const rawType = asString(raw.type);
  const rawTool = asString(raw.tool);
  const rawContent =
    asString(raw.content) ??
    asString(raw.answer) ??
    asString(raw.final) ??
    asString(raw.response);

  const rawInput =
    raw.input ??
    raw.arguments ??
    raw.args ??
    raw.params ??
    raw.parameters ??
    raw.payload ??
    undefined;

  // Explicit final response.
  if (rawType === 'final_response') {
    return {
      type: 'final_response',
      content: rawContent ?? '',
    };
  }

  // Canonical tool_call shape.
  if (rawType === 'tool_call' && rawTool) {
    return {
      type: 'tool_call',
      tool: rawTool,
      input: rawInput ?? {},
    };
  }

  // Legacy shape: { tool: "...", input: ... }
  if (rawTool) {
    return {
      type: 'tool_call',
      tool: rawTool,
      input: rawInput ?? {},
    };
  }

  // Ambiguous shape: { type: "<tool-name>", input: ... }
  if (rawType && availableTools.includes(rawType)) {
    return {
      type: 'tool_call',
      tool: rawType,
      input: rawInput ?? {},
    };
  }

  // Ambiguous shape: { type: "tool_name", ... } where tool name contains non-word chars
  // or the model used the type field as the tool name.
  if (rawType && availableTools.includes(rawType)) {
    return {
      type: 'tool_call',
      tool: rawType,
      input: rawInput ?? {},
    };
  }

  // Final-answer fallbacks.
  if (rawContent) {
    return {
      type: 'final_response',
      content: rawContent,
    };
  }

  return null;
}

function parseStructuredResponse(
  llmText: string,
  availableTools: string[]
): ParsedStructuredResponse {
  const cleaned = stripMarkdownFences(llmText);

  // 1) First try the existing parser if present.
  try {
    const parsed = parseLLMResponse(cleaned) as unknown;
    const normalized = normalizeStructuredResponse(parsed, availableTools);
    if (normalized) return normalized;
  } catch (e) {
    logger.debug('tool-loop: primary parser failed, falling back', { error: String(e) });
  }

  // 2) Try raw JSON recovery.
  const raw = safeJsonParse(cleaned);
  if (raw !== null) {
    const normalized = normalizeStructuredResponse(raw, availableTools);
    if (normalized) return normalized;
  }

  // 3) If the model returned a JSON-looking but malformed payload, we do not
  // treat it as final yet; caller may choose to repair/retry.
  return null;
}

function looksLikeStructuredToolCall(text: string, availableTools: string[]): boolean {
  const cleaned = stripMarkdownFences(text).toLowerCase();

  if (
    cleaned.includes('"tool"') ||
    cleaned.includes('"type":"tool_call"') ||
    cleaned.includes('"input"')
  ) {
    return true;
  }

  // Legacy model formats like {"type":"web-fetch","input":{...}}
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
  availableTools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>,
  preferredTool?: string | null
): string {
  const lines: string[] = [];
  lines.push('TOOL CONTRACT');
  lines.push('');
  lines.push('When a tool is needed, respond with ONLY valid JSON in one of these forms:');
  lines.push('');
  lines.push('1) Canonical tool call:');
  lines.push('{');
  lines.push('  "type": "tool_call",');
  lines.push('  "tool": "<tool-name>",');
  lines.push('  "input": { ... }');
  lines.push('}');
  lines.push('');
  lines.push('2) Final response:');
  lines.push('{');
  lines.push('  "type": "final_response",');
  lines.push('  "content": "..."');
  lines.push('}');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Do not wrap JSON in markdown fences.');
  lines.push('- Do not add explanations outside JSON.');
  lines.push('- Do not output any keys other than type/tool/input/content.');
  if (preferredTool) {
    lines.push(`- Preferred tool hint: ${preferredTool}`);
  }
  lines.push('');

  if (availableTools.length > 0) {
    lines.push('AVAILABLE TOOLS');
    for (const tool of availableTools) {
      lines.push('');
      lines.push(`Tool: ${tool.name}`);
      if (tool.description) lines.push(`Description: ${tool.description}`);
      if (tool.inputSchema !== undefined) {
        try {
          lines.push(`Input schema: ${JSON.stringify(tool.inputSchema, null, 2)}`);
        } catch {
          lines.push('Input schema: [unserializable]');
        }
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

  if (preferredTool) {
    parts.push(`Preferred tool from reasoning engine: ${preferredTool}`);
  }

  if (repairMode) {
    parts.push(
      [
        'Your previous response was not valid tool-call JSON.',
        'Retry using valid JSON only.',
        'Return ONLY one JSON object.',
        'Do not wrap in markdown fences.',
      ].join('\n')
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
    const toolEntries = this.registry.listTools().map((t: any) => ({
      name: String(t?.manifest?.name ?? ''),
      description: t?.manifest?.description,
      inputSchema: t?.manifest?.inputSchema ?? t?.manifest?.schema,
    })).filter((t: any) => t.name);

    const availableTools = toolEntries.map((t) => t.name);
    const stepMessages: Message[] = [];
    const toolsUsed: string[] = [];
    let toolSteps = 0;
    let repairAttempts = 0;

    // Working copy of messages — may grow as we inject tool results.
    let currentMessages = [...messages];

    for (let step = 0; step <= this.opts.maxSteps; step++) {
      const isLastStep = step === this.opts.maxSteps;
      const toolContractBlock = buildStrictToolContractBlock(
        toolEntries,
        this.opts.preferredTool
      );

      // If we've already used tools and hit the final step, nudge the model
      // toward synthesis rather than additional tool requests.
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

      // Call LLM
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

        const { extractText } = require('../types/message') as typeof import('../types/message');
        llmText = extractText(response.message.content);
      } catch (e) {
        const errMsg = `LLM call failed at step ${step}: ${String(e)}`;
        logger.warn(errMsg);
        return { finalText: `❌ ${errMsg}`, toolSteps, toolsUsed, stepMessages };
      }

      stepMessages.push(createMessage({ role: 'assistant', content: llmText }));

      // Parse the LLM response into a normalized structured shape.
      const parsed = parseStructuredResponse(llmText, availableTools);

      // Case 1: LLM wants to call a tool
      if (parsed?.type === 'tool_call') {
        // Last step: if the model still asks for a tool, try to execute it if
        // possible; otherwise return a helpful fallback instead of leaking JSON.
        if (isLastStep) {
          const validationError = validateToolCall(parsed as any, availableTools);
          if (validationError) {
            logger.warn('tool-loop: invalid tool call at max step', {
              error: validationError,
              modelOutput: llmText,
            });
            return { finalText: `❌ ${validationError}`, toolSteps, toolsUsed, stepMessages };
          }

          const tool = this.registry.getTool(parsed.tool) as any;
          if (!tool) {
            return {
              finalText: `❌ Tool "${parsed.tool}" was requested but is not available.`,
              toolSteps,
              toolsUsed,
              stepMessages,
            };
          }

          logger.info('tool-loop: executing tool on final step', {
            tool: parsed.tool,
            input: parsed.input,
            step,
          });

          let toolResult: string;
          try {
            toolResult = await tool.run(parsed.input ?? {});
          } catch (e) {
            toolResult = `Tool execution failed: ${String(e)}`;
            logger.warn('tool-loop: tool error on final step', {
              tool: parsed.tool,
              error: String(e),
            });
          }

          toolsUsed.push(parsed.tool);
          toolSteps++;

          return {
            finalText: toolResult,
            toolSteps,
            toolsUsed,
            stepMessages,
          };
        }

        // Validate tool
        const validationError = validateToolCall(parsed as any, availableTools);
        if (validationError) {
          logger.warn('tool-loop: invalid tool call', {
            error: validationError,
            modelOutput: llmText,
          });

          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;

            currentMessages = [
              ...currentMessages,
              createMessage({
                role: 'user',
                content: buildRepairPrompt(llmText, availableTools),
              }),
            ];

            logger.debug('tool-loop: repair retry queued', {
              repairAttempts,
              step,
            });
            continue;
          }

          return { finalText: `❌ ${validationError}`, toolSteps, toolsUsed, stepMessages };
        }

        const tool = this.registry.getTool(parsed.tool) as any;
        if (!tool) {
          const errMsg = `Tool "${parsed.tool}" is not registered.`;
          logger.warn('tool-loop: tool missing', { tool: parsed.tool });

          if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
            repairAttempts++;
            currentMessages = [
              ...currentMessages,
              createMessage({
                role: 'user',
                content: buildRepairPrompt(
                  `Requested unavailable tool: ${parsed.tool}\n\n${llmText}`,
                  availableTools
                ),
              }),
            ];
            continue;
          }

          return { finalText: `❌ ${errMsg}`, toolSteps, toolsUsed, stepMessages };
        }

        logger.info('tool-loop: executing tool', {
          tool: parsed.tool,
          input: parsed.input,
          step,
        });

        let toolResult: string;
        try {
          toolResult = await tool.run(parsed.input ?? {});
        } catch (e) {
          toolResult = `Tool execution failed: ${String(e)}`;
          logger.warn('tool-loop: tool error', { tool: parsed.tool, error: String(e) });
        }

        toolsUsed.push(parsed.tool);
        toolSteps++;

        // Inject tool result back into message history and loop again.
        const assistantMsg = createMessage({ role: 'assistant', content: llmText });
        const toolResultMsg = buildToolResultMessage(parsed.tool, toolResult);
        currentMessages = [...currentMessages, assistantMsg, toolResultMsg];

        logger.debug('tool-loop: result injected, continuing', {
          tool: parsed.tool,
          step,
          toolSteps,
        });
        continue;
      }

      // Case 2: LLM returned a structured final response
      if (parsed?.type === 'final_response') {
        logger.debug('tool-loop: structured final_response', { step, toolSteps });
        return {
          finalText: parsed.content.trim() || llmText,
          toolSteps,
          toolsUsed,
          stepMessages,
        };
      }

      // Case 3: The text looks like tool JSON but parsing failed.
      if (looksLikeStructuredToolCall(llmText, availableTools)) {
        logger.warn('tool-loop: structured output detected but parse failed', {
          step,
          repairAttempts,
          modelOutput: llmText,
        });

        if (this.opts.enableRepair && repairAttempts < this.opts.maxRepairAttempts) {
          repairAttempts++;
          currentMessages = [
            ...currentMessages,
            createMessage({
              role: 'user',
              content: buildRepairPrompt(llmText, availableTools),
            }),
          ];
          continue;
        }

        return {
          finalText:
            '❌ The model produced a tool-call-like response, but it could not be parsed safely.',
          toolSteps,
          toolsUsed,
          stepMessages,
        };
      }

      // Case 4: Plain text (no JSON) — treat as final answer.
      logger.debug('tool-loop: plain text final response', { step, toolSteps });
      return { finalText: llmText, toolSteps, toolsUsed, stepMessages };
    }

    // Fallback if the loop is exhausted unexpectedly.
    return {
      finalText: '',
      toolSteps,
      toolsUsed,
      stepMessages,
    };
  }
}