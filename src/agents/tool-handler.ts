/**
 * agents/tool-handler.ts
 * Rule-based tool detection and execution layer.
 *
 * Runs BEFORE the LLM call. If a pattern matches, the corresponding
 * tool is executed and the result returned immediately — no API token
 * consumed, near-zero latency.
 *
 * Detection order matters — more specific patterns are checked first.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Pattern                          │ Tool        │ Example        │
 * ├─────────────────────────────────────────────────────────────────┤
 * │ /api/ path or "get data from API"│ api-client  │ get /api/users │
 * │ news / headlines                 │ web-fetch   │ news today     │
 * │ fetch url / open url             │ web-fetch   │ fetch url x.com│
 * │ time / date / uptime / platform  │ system      │ what time is it│
 * └─────────────────────────────────────────────────────────────────┘
 */

import { createLogger } from '../utils/logger';
import { runWebFetch } from '../tools/web-fetch';
import { runSystemTool } from '../tools/system';
import { runApiClient } from '../tools/api-client';

const logger = createLogger('agent:tool-handler');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolResult {
  /** true = tool matched and ran; false = pass to LLM */
  handled: boolean;
  /** Human-readable response (when handled = true). */
  response?: string;
  /** Which tool ran (for logging). */
  toolName?: string;
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

// API tool — highest priority (most specific)
const API_PATTERNS: RegExp[] = [
  /(?:get|fetch|call|query|request)\s+(?:data\s+from\s+)?api\s+(\/\S+)/i,
  /(?:get|fetch|call)\s+(\/api\/\S+)/i,
  /api\s+get\s+(\/?\S+)/i,
  /query\s+(\/api\/\S+)/i,
];

// URL fetch
const URL_PATTERNS: RegExp[] = [
  /(?:fetch|open|get)\s+url\s+(\S+)/i,
  /(?:browse|visit|go\s+to)\s+(https?:\/\/\S+)/i,
];

// News patterns
const NEWS_PATTERNS: RegExp[] = [
  /(?:what(?:'s|\s+is)\s+(?:the\s+)?)?(?:latest\s+)?news\b/i,
  /(?:top\s+)?headlines?\b/i,
  /what(?:'s|\s+is)\s+happening\s+(?:today|now|in\s+the\s+world)/i,
  /current\s+events?\b/i,
];

// System / time patterns
const SYSTEM_PATTERNS: RegExp[] = [
  /what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?time\b/i,
  /(?:current\s+)?(?:local\s+)?time\s+(?:now|please|is\s+it)?\b/i,
  /what\s+time\s+is\s+it\b/i,
  /what(?:'s|\s+is)\s+(?:today's?\s+)?(?:the\s+)?date\b/i,
  /today(?:'s)?\s+date\b/i,
  /what\s+day\s+is\s+(?:it|today)\b/i,
  /system\s+(?:uptime|info|platform|status)\b/i,
  /(?:check\s+)?uptime\b/i,
  /(?:os|operating\s+system|hardware)\s+(?:info|details)?\b/i,
];

// ─── Detection helpers ────────────────────────────────────────────────────────

function matchAny(patterns: RegExp[], input: string): RegExpExecArray | null {
  for (const p of patterns) {
    const m = p.exec(input);
    if (m) return m;
  }
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleTool(input: string): Promise<ToolResult> {
  const trimmed = input.trim();

  // ── 1. API client ───────────────────────────────────────────────────────────
  const apiMatch = matchAny(API_PATTERNS, trimmed);
  if (apiMatch) {
    const path = apiMatch[1] ?? trimmed;
    logger.info('tool: api-client', { path });
    const result = await runApiClient(path);
    return { handled: true, response: result.content, toolName: 'api-client' };
  }

  // ── 2. URL fetch ────────────────────────────────────────────────────────────
  const urlMatch = matchAny(URL_PATTERNS, trimmed);
  if (urlMatch) {
    logger.info('tool: web-fetch (url)', { input: trimmed });
    const result = await runWebFetch(trimmed);
    return { handled: true, response: result.content, toolName: 'web-fetch' };
  }

  // ── 3. News ─────────────────────────────────────────────────────────────────
  if (matchAny(NEWS_PATTERNS, trimmed)) {
    logger.info('tool: web-fetch (news)');
    const result = await runWebFetch(trimmed);
    return { handled: true, response: result.content, toolName: 'web-fetch' };
  }

  // ── 4. System ───────────────────────────────────────────────────────────────
  if (matchAny(SYSTEM_PATTERNS, trimmed)) {
    logger.info('tool: system', { input: trimmed });
    const result = runSystemTool(trimmed);
    return { handled: true, response: result.content, toolName: 'system' };
  }

  return { handled: false };
}
