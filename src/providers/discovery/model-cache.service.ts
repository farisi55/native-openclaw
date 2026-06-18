import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import type { IProvider, ModelInfo } from '../../types/provider';
import { createLogger } from '../../utils/logger';
import { getOptionalEnv } from '../../config/env';
import { curatedModelsFor } from './curated-models';
import type {
  ModelSource,
  ProviderModelCacheDocument,
  ProviderModelDiscoveryErrorInfo,
  ProviderModelInfo,
  ProviderModelRegistryFilter,
  ProviderModelStatus,
} from './model-discovery.types';

const DEFAULT_CACHE_PATH = './data/provider-model-cache.json';
const CACHE_VERSION = 1 as const;

const logger = createLogger('provider-model-cache');

function nowIso(): string {
  return new Date().toISOString();
}

function emptyCache(): ProviderModelCacheDocument {
  return {
    version: CACHE_VERSION,
    updatedAt: nowIso(),
    providers: {},
    custom: {},
  };
}

function toModelFromConfigured(providerId: string, model: ModelInfo): ProviderModelInfo {
  const info: ProviderModelInfo = {
    id: model.id,
    providerId,
    displayName: model.name,
    source: 'configured',
    contextWindow: model.contextWindow,
    supportsTools: model.supportsTools,
    supportsVision: model.supportsVision,
    status: 'unknown',
  };
  if (model.maxOutputTokens !== undefined) info.raw = { maxOutputTokens: model.maxOutputTokens };
  return info;
}

function sourceRank(source: ModelSource): number {
  switch (source) {
    case 'custom': return 0;
    case 'configured': return 1;
    case 'curated': return 2;
    case 'discovered': return 3;
  }
}

function normalizeInfo(info: ProviderModelInfo, providerId: string, source?: ModelSource): ProviderModelInfo {
  const normalized: ProviderModelInfo = {
    ...info,
    id: info.id.trim(),
    providerId,
    source: source ?? info.source,
  };
  if (!normalized.status) normalized.status = 'unknown';
  return normalized;
}

function matchesFilter(model: ProviderModelInfo, filter: ProviderModelRegistryFilter): boolean {
  if (filter.providerId && model.providerId !== filter.providerId) return false;
  if (filter.source && model.source !== filter.source) return false;
  if (filter.testedOnly && model.status !== 'tested-ok') return false;
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    const haystack = [
      model.id,
      model.displayName ?? '',
      model.source,
      model.status ?? '',
      model.providerId,
    ].join(' ').toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function mergeByPriority(models: ProviderModelInfo[]): ProviderModelInfo[] {
  const sorted = [...models].sort((a, b) => sourceRank(b.source) - sourceRank(a.source));
  const merged = new Map<string, ProviderModelInfo>();
  for (const model of sorted) {
    if (!model.id.trim()) continue;
    merged.set(`${model.providerId}:${model.id}`, model);
  }
  return [...merged.values()].sort((a, b) => {
    const sourceDelta = sourceRank(a.source) - sourceRank(b.source);
    if (sourceDelta !== 0) return sourceDelta;
    return a.id.localeCompare(b.id);
  });
}

export class ModelCacheService {
  readonly filePath: string;

  constructor(cachePath = getOptionalEnv('PROVIDER_MODEL_DISCOVERY_CACHE_PATH', DEFAULT_CACHE_PATH) ?? DEFAULT_CACHE_PATH) {
    this.filePath = resolve(process.cwd(), cachePath);
  }

  async read(): Promise<ProviderModelCacheDocument> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return emptyCache();
      const record = parsed as Partial<ProviderModelCacheDocument>;
      if (record.version !== CACHE_VERSION) return emptyCache();
      return {
        version: CACHE_VERSION,
        updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
        providers: record.providers && typeof record.providers === 'object' ? record.providers : {},
        custom: record.custom && typeof record.custom === 'object' ? record.custom : {},
      };
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code !== 'ENOENT') {
        logger.warn('model cache unreadable; using empty cache', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return emptyCache();
    }
  }

  async write(cache: ProviderModelCacheDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const next: ProviderModelCacheDocument = {
      ...cache,
      version: CACHE_VERSION,
      updatedAt: nowIso(),
    };
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  async setDiscoveredModels(
    providerId: string,
    models: ProviderModelInfo[],
    error?: ProviderModelDiscoveryErrorInfo
  ): Promise<void> {
    const cache = await this.read();
    const normalized = models
      .map((model) => normalizeInfo(model, providerId, 'discovered'))
      .filter((model) => model.id.length > 0);
    cache.providers[providerId] = {
      updatedAt: nowIso(),
      models: normalized,
      ...(error ? { lastError: error } : {}),
    };
    await this.write(cache);
  }

  async rememberDiscoveryError(providerId: string, error: ProviderModelDiscoveryErrorInfo): Promise<void> {
    const cache = await this.read();
    const existing = cache.providers[providerId] ?? { models: [] };
    cache.providers[providerId] = {
      ...existing,
      lastError: error,
    };
    await this.write(cache);
  }

  async addCustomModel(providerId: string, modelId: string): Promise<ProviderModelInfo> {
    const cache = await this.read();
    const model: ProviderModelInfo = {
      id: modelId.trim(),
      providerId,
      source: 'custom',
      status: 'unknown',
    };
    const existing = cache.custom[providerId] ?? [];
    cache.custom[providerId] = mergeByPriority([
      ...existing.map((item) => normalizeInfo(item, providerId, 'custom')),
      model,
    ]).filter((item) => item.source === 'custom');
    await this.write(cache);
    return model;
  }

  async removeCustomModel(providerId: string, modelId: string): Promise<boolean> {
    const cache = await this.read();
    const existing = cache.custom[providerId] ?? [];
    const next = existing.filter((model) => model.id !== modelId);
    cache.custom[providerId] = next;
    await this.write(cache);
    return next.length !== existing.length;
  }

  async updateModelStatus(
    providerId: string,
    modelId: string,
    status: ProviderModelStatus,
    lastError?: string
  ): Promise<void> {
    const cache = await this.read();
    const update = (models: ProviderModelInfo[]): ProviderModelInfo[] => models.map((model) => {
      if (model.providerId !== providerId || model.id !== modelId) return model;
      const next: ProviderModelInfo = {
        ...model,
        status,
        lastTestedAt: nowIso(),
      };
      if (lastError !== undefined) next.lastError = lastError;
      else delete next.lastError;
      return next;
    });

    if (cache.providers[providerId]) {
      cache.providers[providerId] = {
        ...cache.providers[providerId]!,
        models: update(cache.providers[providerId]!.models),
      };
    }
    if (cache.custom[providerId]) cache.custom[providerId] = update(cache.custom[providerId]!);
    await this.write(cache);
  }

  async providerModels(provider: IProvider, configured: ModelInfo[]): Promise<ProviderModelInfo[]> {
    const cache = await this.read();
    const configuredModels = configured.map((model) => toModelFromConfigured(provider.id, model));
    const discovered = (cache.providers[provider.id]?.models ?? [])
      .map((model) => normalizeInfo(model, provider.id, 'discovered'));
    const custom = (cache.custom[provider.id] ?? [])
      .map((model) => normalizeInfo(model, provider.id, 'custom'));
    const curated = curatedModelsFor(provider.id);
    return mergeByPriority([...discovered, ...curated, ...configuredModels, ...custom]);
  }

  async allModels(
    providers: Iterable<IProvider>,
    configuredModels: (provider: IProvider) => Promise<ModelInfo[]>,
    filter: ProviderModelRegistryFilter = {}
  ): Promise<ProviderModelInfo[]> {
    const all: ProviderModelInfo[] = [];
    for (const provider of providers) {
      if (filter.providerId && provider.id !== filter.providerId) continue;
      let configured: ModelInfo[] = [];
      try {
        configured = await configuredModels(provider);
      } catch {
        configured = [];
      }
      all.push(...await this.providerModels(provider, configured));
    }
    const filtered = all.filter((model) => matchesFilter(model, filter));
    const limit = filter.limit ?? filtered.length;
    return filtered.slice(0, Math.max(0, limit));
  }
}

