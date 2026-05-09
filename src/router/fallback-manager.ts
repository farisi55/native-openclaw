/**
 * router/fallback-manager.ts
 * Wraps a provider call with automatic retry-on-failure + fallback chain.
 */

import type { IProvider, ChatOptions, ChatResponse, ProviderRegistry } from '../types/provider';
import { ProviderError } from '../types/provider';
import type { ProviderHealthTracker } from './provider-health';
import type { RoutingStrategy, RoutingHint } from './routing-strategy';
import { createLogger } from '../utils/logger';

const logger = createLogger('router:fallback');

export interface FallbackResult {
  response: ChatResponse;
  providerId: string;
  model: string;
  usedFallback: boolean;
  attemptCount: number;
}

export class FallbackManager {
  private readonly health: ProviderHealthTracker;
  private readonly strategy: RoutingStrategy;
  private readonly providers: ProviderRegistry;

  constructor(
    providers: ProviderRegistry,
    health: ProviderHealthTracker,
    strategy: RoutingStrategy
  ) {
    this.providers  = providers;
    this.health     = health;
    this.strategy   = strategy;
  }

  /**
   * Execute a chat request with automatic fallback.
   *
   * @param primaryProviderId - The caller's preferred provider.
   * @param primaryModel      - The caller's preferred model.
   * @param options           - ChatOptions (model will be overridden per provider).
   * @param hint              - Optional routing hint to improve provider selection.
   * @param maxAttempts       - Max providers to try before giving up.
   */
  async chat(
    primaryProviderId: string,
    primaryModel: string,
    options: ChatOptions,
    hint: RoutingHint = {},
    maxAttempts = 4
  ): Promise<FallbackResult> {
    // Build candidate list: preferred provider first, then ranked fallbacks
    const ranked = this.strategy.rank(this.providers, hint);
    const primaryProvider = this.providers.get(primaryProviderId);

    // Put primary first if it's healthy
    const candidates: Array<{ provider: IProvider; model: string }> = [];
    if (primaryProvider && this.health.isHealthy(primaryProviderId)) {
      candidates.push({ provider: primaryProvider, model: primaryModel });
    }
    for (const p of ranked) {
      if (p.id !== primaryProviderId && candidates.length < maxAttempts) {
        const fallbackModel = await this.defaultModel(p);
        if (fallbackModel) candidates.push({ provider: p, model: fallbackModel });
      }
    }

    let lastError: Error | null = null;
    let attemptCount = 0;

    for (const { provider, model } of candidates) {
      attemptCount++;
      const opts: ChatOptions = { ...options, model };

      try {
        const start = Date.now();
        const response = await provider.chat(opts);
        const latencyMs = Date.now() - start;

        this.health.recordSuccess(
          provider.id,
          latencyMs,
          response.usage?.completionTokens ?? 0
        );

        const usedFallback = provider.id !== primaryProviderId || model !== primaryModel;
        if (usedFallback) {
          logger.info('fallback succeeded', {
            from: primaryProviderId,
            to: provider.id,
            model,
            attempt: attemptCount,
          });
        }

        return { response, providerId: provider.id, model, usedFallback, attemptCount };

      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        this.health.recordFailure(provider.id);

        const shouldRetry = e instanceof ProviderError && e.isRetryable();
        logger.warn('provider attempt failed', {
          provider: provider.id,
          model,
          attempt: attemptCount,
          error: lastError.message.slice(0, 100),
          willRetry: shouldRetry && attemptCount < candidates.length,
        });

        if (!shouldRetry && e instanceof ProviderError && e.code === 'UNAUTHORIZED') {
          // Auth errors won't fix themselves — skip remaining retries for this provider
          continue;
        }
      }
    }

    throw lastError ?? new Error('All providers failed with no error details');
  }

  private async defaultModel(provider: IProvider): Promise<string | null> {
    try {
      const models = await provider.listModels();
      return models[0]?.id ?? null;
    } catch {
      const envKey = `${provider.id.toUpperCase()}_DEFAULT_MODEL`;
      return process.env[envKey] ?? null;
    }
  }
}
