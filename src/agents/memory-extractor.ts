/**
 * agents/memory-extractor.ts
 * Rule-based memory extraction — NO LLM, deterministic, zero-latency.
 *
 * Scans user input for learnable facts and returns structured
 * MemoryUpdate objects that the orchestrator persists to MemoryManager.
 *
 * Patterns detected:
 *   Agent name:
 *     "your name is X"
 *     "call you X"
 *     "call yourself X"
 *     "change your name to X"
 *     "you are called X"
 *     "rename yourself to X"
 *     "from now on you are X"
 *     "from now on your name is X"
 *
 *   User name:
 *     "my name is X"
 *     "i am X" / "i'm X"
 *     "call me X"
 *
 *   Generic fact:
 *     "remember that X is Y"
 *     "remember X = Y"
 */

import { createLogger } from '../utils/logger';
import type { MemoryValue } from '../storage/memory-manager';
import { normalizeUserNameCandidate } from '../memory/user-name';

const logger = createLogger('agent:memory-extractor');

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryScope = 'global' | 'session';

export interface MemoryUpdate {
  scope: MemoryScope;
  key: string;
  value: MemoryValue;
}

// ─── Name extraction helper ───────────────────────────────────────────────────

/**
 * Clean a raw captured name: strip surrounding quotes/punctuation,
 * collapse whitespace, title-case single words.
 */
function cleanName(raw: string): string {
  return raw
    .replace(/^["'`]|["'`.,!?]$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Pattern definitions ──────────────────────────────────────────────────────

/** Patterns that set the AGENT's name (stored in global memory). */
const AGENT_NAME_PATTERNS: RegExp[] = [
  /your\s+name\s+is\s+(.+)/i,
  /call\s+you\s+(.+)/i,
  /call\s+yourself\s+(.+)/i,
  /change\s+your\s+name\s+to\s+(.+)/i,
  /you\s+are\s+called\s+(.+)/i,
  /rename\s+yourself\s+to\s+(.+)/i,
  /you\s+are\s+now\s+(?:called\s+)?(.+)/i,
  /from\s+now\s+on[,\s]+(?:your\s+name\s+is\s+)?(?:you\s+are\s+)?(.+)/i,
];

/** Patterns that set the USER's name (stored in session memory). */
const USER_NAME_PATTERNS: RegExp[] = [
  /\bnama\s+saya\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /\bsaya\s+bernama\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /\bpanggil\s+saya\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /\bnamaku\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /^(?:halo|hai|hi|hello)[,\s]+aku\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /\bmy\s+name\s+is\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /\bcall\s+me\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /^(?:hi|hello|hey)[,\s]+i\s+am\s+([A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/i,
  /^i\s+am\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+){0,3})(?=$|[.,!?])/,
];

/** Generic fact patterns: "remember that <key> is <value>" */
const GENERIC_FACT_PATTERNS: RegExp[] = [
  /remember\s+that\s+(.+?)\s+is\s+(.+)/i,
  /remember\s+(.+?)\s*=\s*(.+)/i,
];

// ─── Main extractor ───────────────────────────────────────────────────────────

/**
 * Extract memory updates from a single user input string.
 * Returns an empty array if no learnable facts are found.
 */
export function extractMemory(userInput: string): MemoryUpdate[] {
  const updates: MemoryUpdate[] = [];
  const input = userInput.trim();

  // 1. Agent name patterns
  for (const pattern of AGENT_NAME_PATTERNS) {
    const match = pattern.exec(input);
    if (match?.[1]) {
      const name = cleanName(match[1]);
      if (name.length > 0 && name.length < 60) {
        updates.push({ scope: 'global', key: 'agentName', value: name });
        logger.info('memory extracted: agentName', { value: name });
        break; // only first match per category
      }
    }
  }

  // 2. User name patterns (only if no agent name already extracted from same input)
  for (const pattern of USER_NAME_PATTERNS) {
    const match = pattern.exec(input);
    if (match?.[1]) {
      const name = normalizeUserNameCandidate(cleanName(match[1]));
      if (name) {
        updates.push({ scope: 'session', key: 'userName', value: name });
        logger.info('memory extracted: userName', { value: name });
        break;
      } else {
        logger.debug('ignored low-confidence userName candidate', { candidate: cleanName(match[1]) });
      }
    }
  }

  // 3. Generic key=value facts
  for (const pattern of GENERIC_FACT_PATTERNS) {
    const match = pattern.exec(input);
    if (match?.[1] && match?.[2]) {
      const key = cleanName(match[1]).replace(/\s+/g, '_').toLowerCase();
      const value = cleanName(match[2]);
      if (key.length > 0 && key.length < 60 && value.length > 0 && value.length < 200) {
        updates.push({ scope: 'global', key, value });
        logger.info('memory extracted: generic fact', { key, value });
      }
    }
  }

  return updates;
}
