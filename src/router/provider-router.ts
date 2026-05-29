/**
 * router/provider-router.ts
 * Central router — combines health tracking, strategy, and fallback.
 * This is the single entry point used by the orchestrator.
 */

import type { IProvider, ChatOptions, ProviderRegistry } from '../types/provider';
import type { RoutingHint } from './routing-strategy';
import { ProviderHealthTracker } from './provider-health';
import { RoutingStrategy } from './routing-strategy';
import { FallbackManager } from './fallback-manager';
import type { FallbackResult } from './fallback-manager';
import { createLogger } from '../utils/logger';

export { ProviderHealthTracker, RoutingStrategy, FallbackManager };
export type { FallbackResult, RoutingHint };

const logger = createLogger('router');

export interface RouterConfig {
  enabled: boolean;
  autoFallback: boolean;
  autoSwitch: boolean;
  maxAttempts: number;
  dataDir: string;
}

export class ProviderRouter {
  readonly health: ProviderHealthTracker;
  readonly strategy: RoutingStrategy;
  readonly fallback: FallbackManager;
  private readonly cfg: RouterConfig;

  constructor(providers: ProviderRegistry, cfg: RouterConfig) {
    this.cfg      = cfg;
    this.health   = new ProviderHealthTracker(cfg.dataDir);
    this.strategy = new RoutingStrategy(this.health);
    this.fallback = new FallbackManager(providers, this.health, this.strategy);
  }

  async init(): Promise<void> {
    await this.health.load();
    logger.info('router initialised', {
      enabled: this.cfg.enabled,
      autoFallback: this.cfg.autoFallback,
      autoSwitch: this.cfg.autoSwitch,
    });
  }

  /**
   * Route a chat request.
   * If router is disabled, uses the primary provider directly (no fallback).
   */
  async chat(
    primaryProvider: IProvider,
    primaryModel: string,
    options: ChatOptions,
    userInput?: string
  ): Promise<FallbackResult> {
    if (!this.cfg.enabled) {
      // Router disabled — direct call, no fallback
      const start = Date.now();
      const response = await primaryProvider.chat({ ...options, model: primaryModel });
      this.health.recordSuccess(primaryProvider.id, Date.now() - start, response.usage?.completionTokens ?? 0);
      return { response, providerId: primaryProvider.id, model: primaryModel, usedFallback: false, attemptCount: 1 };
    }

    const hint: RoutingHint = {};
    if (userInput) {
      hint.taskType = this.strategy.detectTaskType(userInput);
    }

    return this.fallback.chat(
      primaryProvider.id,
      primaryModel,
      options,
      hint,
      this.cfg.maxAttempts
    );
  }

  bestProvider(hint: RoutingHint = {}): IProvider | null {
    return this.strategy.rank(
      (this.fallback as unknown as { providers: ProviderRegistry }).providers,
      hint
    )[0] ?? null;
  }

  getProvider(providerId: string): IProvider | undefined {
    return (this.fallback as unknown as { providers: ProviderRegistry }).providers.get(providerId);
  }

  allProviders(): IProvider[] {
    return [...(this.fallback as unknown as { providers: ProviderRegistry }).providers.values()];
  }
}
