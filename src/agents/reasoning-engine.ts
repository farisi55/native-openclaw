/**
 * agents/reasoning-engine.ts
 * Lightweight reasoning-first layer.
 *
 * Before calling the tool loop, asks a micro-LLM call to decide:
 *   - Does this need a tool?
 *   - Which tool?
 *   - Or can it be answered from memory/context?
 *
 * The reasoning output is INTERNAL — never shown to the user.
 * It drives tool selection without hard-coded rules.
 */

import type { IProvider } from '../types/provider';
import type { ToolRegistry } from '../tools/tool-registry';
import { createLogger } from '../utils/logger';
import { createMessage, extractText } from '../types/message';
import { normalizeToolName } from './tool-loop';
import { isApplicationDebugRequest } from './application-debug-intent';
import { isSelfUpgradeIntent } from '../self-healing';

const logger = createLogger('agents:reasoning');
const CURRENT_INFO_RE = /\b(news|latest news|current events?|today'?s? news|current\s+(\w+\s+)?price|market update|football transfer|transfer news|search internet|web lookup)\b|berita\s+(terbaru|hari ini|transfer|sepakbola|bola|pasar|harga)|harga\s+(\w+\s+)?(hari ini|sekarang|terkini|terbaru)|update\s+pasar|informasi\s+terbaru\s+tentang|berita\s+terkini|transfer\s+sepakbola/i;
const REAL_TIME_REASON = 'Requires real-time internet access';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReasoningResult {
  /** Whether a tool is needed for this request. */
  needsTool: boolean;
  /** The tool name if needsTool is true. */
  tool: string | null;
  /** Reasoning summary (internal, not shown to user). */
  reason: string;
  /** Whether to skip tool loop and answer directly from context. */
  directAnswer: boolean;
  /** The direct answer text (when directAnswer is true). */
  answerText?: string;
}

// ─── System prompt for reasoning step ────────────────────────────────────────

function buildReasoningPrompt(toolNames: string[], toolDescriptions: string): string {
  return [
    '## REASONING TASK',
    '',
    'You are an internal reasoning module. Analyse the user request and decide:',
    '1. Can it be answered from general knowledge (no tool needed)?',
    '2. Does it require real-time data, system info, or API calls (tool needed)?',
    '',
    'Available tools:',
    toolDescriptions,
    '',
    'Respond ONLY with valid JSON in ONE of these formats:',
    '',
    'If tool needed:',
    '{"goal":"<what user wants>","needsTool":true,"tool":"<tool-name>","reason":"<why tool>"}',
    '',
    'If no tool needed:',
    '{"goal":"<what user wants>","needsTool":false,"tool":null,"reason":"<can answer directly>"}',
    '',
    `Valid tool names: ${toolNames.join(', ')}`,
    '',
    'Tool name rules:',
    '- Use ONLY exact valid tool names.',
    '- Do not invent tool names.',
    '- For news, latest information, current events, web lookup, current prices, or market updates, use web-fetch if available.',
    '- For Native OpenClaw logging, config, debug, or "suppress error log" requests, do NOT use system-execute unless the user explicitly asks to run a shell command.',
    '- For Telegram polling errors, treat the request as application debugging/config first, not as an external Telegram action.',
    '- For self-upgrade requests, optimization requests, new capability requests, token efficiency work, or "Request too large" prevention, do NOT use system-execute; route through SelfUpgradeEngine before this reasoning step.',
    '- Never use news_api, news, search_api, web_search, browser, or browse unless that exact name is in the valid tool list.',
    '- If no valid suitable tool exists, set needsTool to false.',
    '',
    'DO NOT add any text outside the JSON.',
  ].join('\n');
}

// ─── Reasoning Engine ─────────────────────────────────────────────────────────

export class ReasoningEngine {
  private readonly registry: ToolRegistry;
  private readonly maxTokens = 256;   // keep reasoning micro-call cheap

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Run a fast reasoning micro-call to determine tool selection.
   *
   * Uses the same provider as the main turn (provider-agnostic).
   * Falls back gracefully if the reasoning call fails.
   */
  async reason(
    userInput: string,
    provider: IProvider,
    model: string
  ): Promise<ReasoningResult> {
    const tools = this.registry.listTools();
    if (tools.length === 0) {
      return { needsTool: false, tool: null, reason: 'No tools available', directAnswer: false };
    }

    const toolNames = tools.map((t) => t.manifest.name);
    const toolDescriptions = tools
      .map((t) => `- ${t.manifest.name}: ${t.manifest.description}`)
      .join('\n');

    if (isApplicationDebugRequest(userInput)) {
      return {
        needsTool: false,
        tool: null,
        reason: 'Application logging/config debug request; system-execute is not appropriate without an explicit shell command request.',
        directAnswer: false,
      };
    }

    if (isSelfUpgradeIntent(userInput)) {
      return {
        needsTool: false,
        tool: null,
        reason: 'Self-upgrade request; route through SelfUpgradeEngine instead of direct tool execution.',
        directAnswer: false,
      };
    }

    if (toolNames.includes('web-fetch') && CURRENT_INFO_RE.test(userInput)) {
      return {
        needsTool: true,
        tool: 'web-fetch',
        reason: REAL_TIME_REASON,
        directAnswer: false,
      };
    }

    const systemPrompt = buildReasoningPrompt(toolNames, toolDescriptions);

    try {
      const response = await provider.chat({
        model,
        messages: [createMessage({ role: 'user', content: userInput })],
        systemPrompt,
        temperature: 0,   // deterministic reasoning
        maxTokens: this.maxTokens,
      });

      const raw = extractText(response.message.content).trim();
      logger.debug('reasoning raw output', { raw: raw.slice(0, 200) });

      // Parse the JSON reasoning output
      const parsed = this.parseReasoningOutput(raw, toolNames);
      logger.info('reasoning result', {
        needsTool: parsed.needsTool,
        tool: parsed.tool,
        reason: parsed.reason,
      });
      return parsed;

    } catch (e) {
      // If reasoning call fails, fall through to the normal tool loop
      logger.warn('reasoning call failed — skipping reasoning step', { error: String(e) });
      return { needsTool: false, tool: null, reason: 'Reasoning unavailable', directAnswer: false };
    }
  }

  private parseReasoningOutput(raw: string, validTools: string[]): ReasoningResult {
    // Extract JSON (may be wrapped in markdown fences)
    const jsonMatch = /\{[\s\S]*\}/.exec(raw);
    if (!jsonMatch) {
      return { needsTool: false, tool: null, reason: 'Could not parse reasoning output', directAnswer: false };
    }

    try {
      const obj = JSON.parse(jsonMatch[0]) as {
        needsTool?: boolean;
        tool?: string | null;
        reason?: string;
        goal?: string;
      };

      const needsTool = Boolean(obj.needsTool);
      const rawTool   = typeof obj.tool === 'string' ? obj.tool : null;
      const normalizedTool = rawTool ? normalizeToolName(rawTool, validTools) : null;
      const tool      = needsTool && normalizedTool && validTools.includes(normalizedTool) ? normalizedTool : null;
      const reason    = typeof obj.reason === 'string' ? obj.reason : '';

      // If LLM said it needs a tool but gave an invalid name, clear needsTool
      if (needsTool && !tool) {
        return { needsTool: false, tool: null, reason: `Invalid tool name: ${rawTool}`, directAnswer: false };
      }

      return { needsTool: needsTool && tool !== null, tool, reason, directAnswer: false };

    } catch {
      return { needsTool: false, tool: null, reason: 'JSON parse error in reasoning', directAnswer: false };
    }
  }
}
