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
  private readonly modelCache = new Map<string, string>();
  private readonly modelCachePromises = new Map<string, Promise<string | null>>();

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

    const fallbackCandidates = await Promise.all(
      ranked
        .filter((p) => p.id !== primaryProviderId)
        .slice(0, maxAttempts - 1)
        .map(async (p) => {
          const model = await this.defaultModel(p);
          return model ? { provider: p, model } : null;
        })
    );

    for (const candidate of fallbackCandidates) {
      if (candidate && candidates.length < maxAttempts) {
        candidates.push(candidate);
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

  clearModelCache(): void {
    this.modelCache.clear();
    this.modelCachePromises.clear();
  }

  private async defaultModel(provider: IProvider): Promise<string | null> {
    const cached = this.modelCache.get(provider.id);
    if (cached) return cached;

    const envKey = `${provider.id.toUpperCase()}_DEFAULT_MODEL`;
    const envModel = process.env[envKey];
    if (envModel) {
      this.modelCache.set(provider.id, envModel);
      return envModel;
    }

    const existing = this.modelCachePromises.get(provider.id);
    if (existing) return existing;

    const promise = provider.listModels()
      .then((models) => {
        const model = models[0]?.id ?? null;
        if (model) this.modelCache.set(provider.id, model);
        return model;
      })
      .catch(() => null)
      .finally(() => {
        this.modelCachePromises.delete(provider.id);
      });

    this.modelCachePromises.set(provider.id, promise);
    return promise;
  }
}
