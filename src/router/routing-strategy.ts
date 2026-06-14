/**
 * router/routing-strategy.ts
 * Scoring and selection strategy for choosing the best provider per task.
 */

import type { ProviderHealthTracker } from './provider-health';
import type { IProvider, ProviderRegistry } from '../types/provider';
import { createLogger } from '../utils/logger';

const logger = createLogger('router:strategy');

export type TaskType = 'fast_chat' | 'reasoning' | 'local' | 'vision' | 'coding' | 'general';

export interface RoutingHint {
  taskType?: TaskType;
  preferLocal?: boolean;
  minContextWindow?: number;
  requireVision?: boolean;
  requireTools?: boolean;
}

// Provider preference tiers per task type
const TASK_PREFERENCE: Record<TaskType, string[]> = {
  fast_chat:  ['groq', 'sambanova', 'cloudflare', 'github-models', 'openrouter', 'mistral', 'ollama'],
  reasoning:  ['sambanova', 'gemini', 'github-models', 'cloudflare', 'openrouter', 'groq', 'ollama'],
  local:      ['ollama'],
  vision:     ['gemini', 'github-models', 'openrouter', 'ollama'],
  coding:     ['sambanova', 'groq', 'github-models', 'mistral', 'cloudflare', 'openrouter', 'ollama'],
  general:    ['groq', 'sambanova', 'mistral', 'cloudflare', 'github-models', 'openrouter', 'gemini', 'ollama'],
};

// Default fallback chain
const DEFAULT_FALLBACK_CHAIN = [
  'groq',
  'sambanova',
  'mistral',
  'cloudflare',
  'github-models',
  'openrouter',
  'gemini',
  'ollama',
];

export function configuredProviderOrder(): string[] {
  const configured = (process.env['PROVIDER_ORDER'] ?? '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? [...new Set(configured)] : DEFAULT_FALLBACK_CHAIN;
}

export class RoutingStrategy {
  private readonly health: ProviderHealthTracker;

  constructor(health: ProviderHealthTracker) {
    this.health = health;
  }

  /**
   * Score a provider for the given task. Higher = better.
   */
  score(providerId: string, hint: RoutingHint = {}): number {
    if (!this.health.isHealthy(providerId)) return -1000;

    let score = 100;

    // Task type preference bonus
    const taskType = hint.taskType ?? 'general';
    const configured = process.env['PROVIDER_ORDER']?.trim();
    const preferred = configured
      ? configuredProviderOrder()
      : (TASK_PREFERENCE[taskType] ?? DEFAULT_FALLBACK_CHAIN);
    const preferenceIdx = preferred.indexOf(providerId);
    if (preferenceIdx === -1) score -= 30;
    else score += (preferred.length - preferenceIdx) * 15;

    // Local preference
    if (hint.preferLocal && providerId === 'ollama') score += 50;

    // Latency bonus (lower = better)
    const avgLat = this.health.avgLatency(providerId);
    if (avgLat < 2000)      score += 20;
    else if (avgLat < 5000) score += 10;
    else if (avgLat < 10000) score += 0;
    else                    score -= 10;

    // Success rate bonus
    const sr = this.health.successRate(providerId);
    score += Math.round(sr * 20);

    return score;
  }

  /**
   * Return providers sorted by score (best first), filtered to healthy only.
   */
  rank(providers: ProviderRegistry, hint: RoutingHint = {}): IProvider[] {
    const scored: Array<[IProvider, number]> = [];
    for (const [id, provider] of providers) {
      const s = this.score(id, hint);
      if (s > -999) scored.push([provider, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    logger.debug('provider ranking', {
      hint,
      ranked: scored.map(([p, s]) => `${p.id}:${s}`),
    });
    return scored.map(([p]) => p);
  }

  /**
   * Detect task type from user input heuristics.
   */
  detectTaskType(userInput: string): TaskType {
    const t = userInput.toLowerCase();
    if (/\b(reason|think|analyze|compare|explain why|step by step)\b/.test(t)) return 'reasoning';
    if (/\b(code|function|class|bug|typescript|python|javascript|program)\b/.test(t)) return 'coding';
    if (/\b(image|photo|picture|screenshot|visual|see|look at)\b/.test(t)) return 'vision';
    if (/\b(time|news|weather|search|fetch|api|data)\b/.test(t)) return 'fast_chat';
    return 'general';
  }
}
