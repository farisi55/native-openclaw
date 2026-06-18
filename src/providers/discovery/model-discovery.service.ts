import { getEnvBool, getEnvInt } from '../../config/env';
import type { IProvider, ModelInfo, ProviderRegistry } from '../../types/provider';
import { createMessage } from '../../types/message';
import { createLogger } from '../../utils/logger';
import { ModelCacheService } from './model-cache.service';
import {
  ModelDiscoveryError,
  type ProviderModelDiscoveryAdapter,
  type ProviderModelDiscoveryErrorInfo,
  type ProviderModelDiscoveryResult,
  type ProviderModelInfo,
  type ProviderModelRegistryFilter,
} from './model-discovery.types';
import { GitHubModelsDiscoveryAdapter } from './adapters/github-models.discovery';
import { CohereDiscoveryAdapter } from './adapters/cohere.discovery';
import { HuggingFaceDiscoveryAdapter } from './adapters/huggingface.discovery';
import { CloudflareDiscoveryAdapter } from './adapters/cloudflare.discovery';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 50;

const logger = createLogger('provider-model-discovery');

function toDiscoveredModel(providerId: string, model: ModelInfo, discoveredAt: string): ProviderModelInfo {
  const info: ProviderModelInfo = {
    id: model.id,
    providerId,
    source: 'discovered',
    status: 'unknown',
    lastDiscoveredAt: discoveredAt,
  };
  if (model.name) info.displayName = model.name;
  if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow;
  if (model.maxOutputTokens !== undefined) {
    info.raw = { ...(model.raw ?? {}), maxOutputTokens: model.maxOutputTokens };
  } else if (model.raw !== undefined) {
    info.raw = model.raw;
  }
  if (model.supportsTools !== undefined) info.supportsTools = model.supportsTools;
  if (model.supportsVision !== undefined) info.supportsVision = model.supportsVision;
  return info;
}

async function withDiscoveryTimeout<T>(
  providerId: string,
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ModelDiscoveryError(
            providerId,
            'DISCOVERY_TIMEOUT',
            `Provider "${providerId}" model discovery timed out.`,
            true
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function disabledResult(
  providerId: string,
  message: string,
  code: ProviderModelDiscoveryErrorInfo['code'] = 'DISCOVERY_UNSUPPORTED'
): ProviderModelDiscoveryResult {
  return {
    providerId,
    ok: false,
    models: [],
    skipped: true,
    error: {
      providerId,
      ok: false,
      code,
      message,
      retryable: false,
    },
  };
}

function normalizeDiscoveryError(providerId: string, error: unknown): ProviderModelDiscoveryErrorInfo {
  if (error instanceof ModelDiscoveryError) return error.toInfo();
  return {
    providerId,
    ok: false,
    code: 'DISCOVERY_NETWORK_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

async function providerConfiguredModels(provider: IProvider): Promise<ModelInfo[]> {
  return provider.listModels();
}

function parseLimit(raw: number | undefined): number {
  if (raw !== undefined) return raw;
  return DEFAULT_LIST_LIMIT;
}

export class ProviderModelDiscoveryService {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly cache = new ModelCacheService(),
    private readonly adapters: ProviderModelDiscoveryAdapter[] = [
      new GitHubModelsDiscoveryAdapter(),
      new HuggingFaceDiscoveryAdapter(),
      new CloudflareDiscoveryAdapter(),
      new CohereDiscoveryAdapter(),
    ]
  ) {}

  get cachePath(): string {
    return this.cache.filePath;
  }

  isEnabled(): boolean {
    return getEnvBool('PROVIDER_MODEL_DISCOVERY_ENABLED', true);
  }

  async refresh(providerId?: string): Promise<ProviderModelDiscoveryResult[]> {
    if (!this.isEnabled()) {
      return [{
        providerId: providerId ?? '*',
        ok: false,
        models: [],
        skipped: true,
        error: {
          providerId: providerId ?? '*',
          ok: false,
          code: 'DISCOVERY_UNSUPPORTED',
          message: 'Provider model discovery is disabled.',
          retryable: false,
        },
      }];
    }

    const targets = this.adapters.filter((adapter) => !providerId || adapter.providerId === providerId);
    const adapterProviderIds = new Set(this.adapters.map((adapter) => adapter.providerId));
    if (providerId && targets.length === 0 && !this.providers.has(providerId)) {
      return [{
        providerId,
        ok: false,
        models: [],
        error: {
          providerId,
          ok: false,
          code: 'DISCOVERY_UNSUPPORTED',
          message: `Provider "${providerId}" does not support model discovery yet.`,
          retryable: false,
        },
      }];
    }

    const results: ProviderModelDiscoveryResult[] = [];
    for (const adapter of targets) {
      if (!adapter.isEnabled()) {
        const message = adapter.disabledReason?.() ?? `${adapter.providerId} discovery is disabled.`;
        const code = message.toLowerCase().includes('missing ')
          ? 'DISCOVERY_AUTH_ERROR'
          : 'DISCOVERY_UNSUPPORTED';
        const result = disabledResult(adapter.providerId, message, code);
        results.push(result);
        await this.cache.rememberDiscoveryError(adapter.providerId, result.error!);
        continue;
      }

      const controller = new AbortController();
      const timeoutMs = getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const models = await adapter.refresh(controller.signal);
        await this.cache.setDiscoveredModels(adapter.providerId, models);
        results.push({ providerId: adapter.providerId, ok: true, models });
        logger.info('provider model discovery refreshed', {
          providerId: adapter.providerId,
          count: models.length,
        });
      } catch (error) {
        const info = normalizeDiscoveryError(adapter.providerId, error);
        await this.cache.rememberDiscoveryError(adapter.providerId, info);
        results.push({
          providerId: adapter.providerId,
          ok: false,
          models: [],
          error: info,
        });
        logger.warn('provider model discovery failed', {
          providerId: adapter.providerId,
          code: info.code,
          message: info.message,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    const genericTargets = [...this.providers.values()].filter((provider) => {
      if (providerId && provider.id !== providerId) return false;
      return !adapterProviderIds.has(provider.id);
    });

    for (const provider of genericTargets) {
      const timeoutMs = getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
      try {
        const listed = await withDiscoveryTimeout(provider.id, provider.listModels(), timeoutMs);
        const discoveredAt = new Date().toISOString();
        const models = listed
          .slice(0, getEnvInt('PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER', 200))
          .map((model) => toDiscoveredModel(provider.id, model, discoveredAt));
        await this.cache.setDiscoveredModels(provider.id, models);
        results.push({ providerId: provider.id, ok: true, models });
        logger.info('provider model discovery refreshed', {
          providerId: provider.id,
          count: models.length,
          source: 'provider-listModels',
        });
      } catch (error) {
        const info = normalizeDiscoveryError(provider.id, error);
        await this.cache.rememberDiscoveryError(provider.id, info);
        results.push({
          providerId: provider.id,
          ok: false,
          models: [],
          error: info,
        });
        logger.warn('provider model discovery failed', {
          providerId: provider.id,
          code: info.code,
          message: info.message,
          source: 'provider-listModels',
        });
      }
    }

    return results;
  }

  async list(filter: ProviderModelRegistryFilter = {}): Promise<ProviderModelInfo[]> {
    const limit = parseLimit(filter.limit);
    const effectiveFilter: ProviderModelRegistryFilter = { ...filter, limit };
    if (!getEnvBool('PROVIDER_MODEL_DISCOVERY_SHOW_UNTESTED', true)) {
      effectiveFilter.testedOnly = true;
    }
    let models: ProviderModelInfo[];
    if (filter.providerId && !this.providers.has(filter.providerId)) {
      const provider: IProvider = {
        id: filter.providerId,
        displayName: filter.providerId,
        async listModels() { return []; },
        async chat() {
          throw new Error(`Provider "${filter.providerId}" is not registered.`);
        },
      };
      models = await this.cache.providerModels(provider, []);
      models = models.filter((model) => {
        if (effectiveFilter.source && model.source !== effectiveFilter.source) return false;
        if (effectiveFilter.testedOnly && model.status !== 'tested-ok') return false;
        if (!effectiveFilter.search) return true;
        return model.id.toLowerCase().includes(effectiveFilter.search.toLowerCase());
      }).slice(0, limit);
    } else {
      models = await this.cache.allModels(
        this.providers.values(),
        providerConfiguredModels,
        effectiveFilter
      );
    }
    if (getEnvBool('PROVIDER_MODEL_DISCOVERY_TOOLS_ONLY', false)) {
      models = models.filter((model) => model.supportsTools === true);
    }
    return models;
  }

  async listProvider(providerId: string, filter: Omit<ProviderModelRegistryFilter, 'providerId'> = {}): Promise<ProviderModelInfo[]> {
    return this.list({ ...filter, providerId });
  }

  async addCustomModel(providerId: string, modelId: string): Promise<ProviderModelInfo> {
    return this.cache.addCustomModel(providerId, modelId);
  }

  async removeCustomModel(providerId: string, modelId: string): Promise<boolean> {
    return this.cache.removeCustomModel(providerId, modelId);
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  async cacheSummary(): Promise<{
    path: string;
    providers: Array<{ providerId: string; models: number; updatedAt?: string; lastError?: string }>;
    custom: Array<{ providerId: string; models: number }>;
  }> {
    const cache = await this.cache.read();
    return {
      path: this.cache.filePath,
      providers: Object.entries(cache.providers).map(([providerId, entry]) => ({
        providerId,
        models: entry.models.length,
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.lastError ? { lastError: entry.lastError.message } : {}),
      })),
      custom: Object.entries(cache.custom).map(([providerId, models]) => ({
        providerId,
        models: models.length,
      })),
    };
  }

  async testModel(providerId: string, modelId: string): Promise<{ ok: boolean; message: string }> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, message: `Provider "${providerId}" is not registered.` };
    }

    try {
      const response = await provider.chat({
        model: modelId,
        messages: [createMessage({ role: 'user', content: 'Reply with exactly: OK' })],
        temperature: 0,
        maxTokens: 4,
      });
      const content = typeof response.message.content === 'string'
        ? response.message.content.trim()
        : '';
      await this.cache.updateModelStatus(providerId, modelId, 'tested-ok');
      return { ok: true, message: content || 'OK' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.cache.updateModelStatus(providerId, modelId, 'tested-failed', message.slice(0, 500));
      return { ok: false, message };
    }
  }
}

export function createProviderModelDiscoveryService(providers: ProviderRegistry): ProviderModelDiscoveryService {
  return new ProviderModelDiscoveryService(providers);
}
