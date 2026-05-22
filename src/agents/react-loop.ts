/**
 * agents/react-loop.ts
 * Lightweight ReAct (Reason → Action → Observe → Answer) agent loop.
 *
 * Internal flow per turn (never exposed to user):
 *   1. REASON  — LLM decides what to do (internal JSON, temp=0)
 *   2. ACTION  — execute tool / browse / command / direct answer
 *   3. OBSERVE — inject tool result back to LLM
 *   4. REASON  — LLM may take another step (max maxSteps)
 *   5. ANSWER  — LLM generates final user-facing response
 *
 * Decision format from LLM:
 *   { "action": "browse"|"tool"|"execute"|"direct"|"clarify",
 *     "tool"?: "tool-name",
 *     "input"?: {...},
 *     "command"?: "shell cmd",
 *     "query"?: "search query",
 *     "reason": "why" }
 */

import type { IProvider } from '../types/provider';
import type { Message }   from '../types/message';
import { createMessage, extractText } from '../types/message';
import type { ToolRegistry }   from '../tools/tool-registry';
import { browse, formatBrowsingResults } from '../tools/browsing';
import { isCommandAllowed, isDangerousCommand, runSystemExecute } from '../tools/system-execute';
import { createLogger } from '../utils/logger';
import { sanitizeFinalAnswer } from './tool-loop';

const logger = createLogger('agents:react-loop');

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReActAction = 'browse' | 'tool' | 'execute' | 'direct' | 'clarify';

export interface ReActDecision {
  action:   ReActAction;
  tool?:    string;
  input?:   Record<string, unknown>;
  command?: string;
  query?:   string;
  reason:   string;
}

export interface ReActResult {
  finalText:  string;
  steps:      number;
  actionsUsed: ReActAction[];
  toolsUsed:  string[];
}

// ─── System prompt for reasoning step ────────────────────────────────────────

function buildReActSystemPrompt(
  toolNames: string[],
  hasBrowsing: boolean,
  hasExecute: boolean
): string {
  const actions: string[] = ['"direct" — answer from knowledge, no tool needed'];
  if (hasBrowsing)  actions.push('"browse" — search the web for real-time data');
  if (toolNames.length > 0) actions.push(`"tool" — use a tool: ${toolNames.join(', ')}`);
  if (hasExecute)   actions.push('"execute" — run a local shell command');
  actions.push('"clarify" — ask the user for more information');

  return [
    '## INTERNAL REASONING MODULE',
    '',
    'You are an internal planning agent. Analyse the user request and decide the best action.',
    'Respond ONLY with valid JSON (no other text):',
    '',
    '```json',
    '{',
    '  "action": "<one of: ' + actions.map((a) => a.split(' — ')[0]).join(' | ') + '>",',
    '  "tool": "<tool name if action=tool>",',
    '  "input": { "<key>": "<value>" },',
    '  "command": "<shell command if action=execute>",',
    '  "query": "<search query if action=browse>",',
    '  "reason": "<brief reason for this decision>"',
    '}',
    '```',
    '',
    '### Available actions:',
    ...actions.map((a) => `- ${a}`),
    '',
    '### Rules:',
    '- Use "browse" for: news, prices, weather, current events, recent facts.',
    '- Use "tool" for: system info, API calls, time/date queries.',
    '- Use "execute" for: shell commands, system operations, file searches.',
    '- Use "direct" when the answer is general knowledge or already in context.',
    '- Keep "reason" short (one sentence).',
  ].join('\n');
}

// ─── JSON extractor ───────────────────────────────────────────────────────────

function extractDecisionJSON(raw: string): ReActDecision | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1]?.trim() ?? (() => {
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    return start !== -1 && end > start ? raw.slice(start, end + 1) : null;
  })();

  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as ReActDecision;
  } catch {
    return null;
  }
}

// ─── ReAct Loop ───────────────────────────────────────────────────────────────

const MAX_STEPS = parseInt(process.env['REACT_MAX_STEPS'] ?? '4', 10);

export class ReActLoop {
  private readonly registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async run(
    provider:     IProvider,
    model:        string,
    userInput:    string,
    baseMessages: Message[],
    systemPrompt: string,
    signal?:      AbortSignal
  ): Promise<ReActResult> {
    const hasBrowsing = !!(process.env['TAVILY_API_KEY'] || process.env['FIRECRAWL_API_KEY']);
    const hasExecute  = process.env['SYSTEM_EXECUTE_ENABLED'] !== 'false';
    const toolNames   = this.registry.listTools().map((t) => t.manifest.name);

    const reactSystemPrompt = buildReActSystemPrompt(toolNames, hasBrowsing, hasExecute);
    const actionsUsed: ReActAction[] = [];
    const toolsUsed:   string[]      = [];
    const observations: string[]     = [];
    let steps = 0;

    // ── Reasoning loop ────────────────────────────────────────────────────────
    for (let i = 0; i < MAX_STEPS; i++) {
      steps++;

      // Build reasoning context: include previous observations
      const reasoningContext = observations.length > 0
        ? `Previous observations:\n${observations.map((o, idx) => `[Step ${idx + 1}]: ${o.slice(0, 400)}`).join('\n\n')}\n\n`
        : '';

      const reasoningMsgs: Message[] = [
        createMessage({ role: 'user', content: `${reasoningContext}User request: "${userInput}"` }),
      ];

      let decision: ReActDecision | null = null;
      try {
        const resp = await provider.chat({
          model,
          messages:     reasoningMsgs,
          systemPrompt: reactSystemPrompt,
          temperature:  0,
          maxTokens:    300,
          ...(signal !== undefined && { signal }),
        });
        const raw = extractText(resp.message.content);
        decision  = extractDecisionJSON(raw);
        logger.debug('react decision', { step: i + 1, decision });
      } catch (e) {
        logger.warn('react reasoning failed', { error: String(e) });
        break;
      }

      if (!decision) { break; }
      actionsUsed.push(decision.action);

      // ── Execute action ────────────────────────────────────────────────────
      let observation = '';

      if (decision.action === 'direct' || decision.action === 'clarify') {
        // No tool needed — fall through to final answer
        break;
      }

      if (decision.action === 'browse') {
        const query    = decision.query ?? userInput;
        const result   = await browse(query);
        observation    = formatBrowsingResults(result, query);
        observations.push(observation);
        logger.info('react: browse complete', { query, ok: result.ok });
        // After browsing, always move to final answer
        break;
      }

      if (decision.action === 'tool' && decision.tool) {
        const tool = this.registry.getTool(decision.tool);
        if (!tool) {
          observation = `Tool "${decision.tool}" not found.`;
        } else {
          try {
            observation = await tool.run(decision.input ?? {});
            toolsUsed.push(decision.tool);
          } catch (e) {
            observation = `Tool "${decision.tool}" failed: ${String(e)}`;
          }
        }
        observations.push(observation);
        logger.info('react: tool complete', { tool: decision.tool });
        break; // After one tool call, proceed to final answer
      }

      if (decision.action === 'execute' && decision.command) {
        if (isDangerousCommand(decision.command)) {
          observation = 'Command rejected: matched dangerous pattern.';
          observations.push(observation);
          logger.warn('react: execute rejected dangerous command', {
            command: decision.command.slice(0, 60),
          });
          continue;
        }

        if (!isCommandAllowed(decision.command)) {
          observation = 'Command rejected: not in allowed command list.';
          observations.push(observation);
          logger.warn('react: execute rejected command outside allowlist', {
            command: decision.command.slice(0, 60),
          });
          continue;
        }

        const result = await runSystemExecute({ command: decision.command });
        observation = result.content;
        observations.push(observation);
        logger.info('react: execute complete', { command: decision.command.slice(0, 60) });
        break;
      }

      // Unknown action — break and answer directly
      break;
    }

    // ── Final answer with observations injected ───────────────────────────────
    const finalMessages: Message[] = [...baseMessages];

    if (observations.length > 0) {
      const obsText = observations
        .map((o, idx) => `OBSERVATION [step ${idx + 1}]:\n${o}`)
        .join('\n\n---\n\n');

      finalMessages.push(createMessage({
        role: 'user',
        content: `${obsText}\n\n---\nBased on the above information, answer the user's question:\n"${userInput}"`,
      }));
    } else {
      finalMessages.push(createMessage({ role: 'user', content: userInput }));
    }

    const finalResp = await provider.chat({
      model,
      messages:     finalMessages,
      systemPrompt,
      temperature:  0.7,
      maxTokens:    4096,
      ...(signal !== undefined && { signal }),
    });

    const finalText = sanitizeFinalAnswer(extractText(finalResp.message.content));
    logger.info('react loop complete', { steps, actionsUsed, toolsUsed });

    return { finalText, steps, actionsUsed, toolsUsed };
  }
}
