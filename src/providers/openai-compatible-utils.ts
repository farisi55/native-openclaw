import { getEnvInt, getOptionalEnv } from '../config/env';
import type { ModelInfo } from '../types/provider';
import type { WireModel } from './base';
import { parseProviderModels } from './provider-env';

export interface StaticModelMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function positiveTimeout(key: string, fallback: number): number {
  const timeout = getEnvInt(key, fallback);
  if (timeout <= 0) throw new Error(`[env] Env var "${key}" must be a positive integer.`);
  return timeout;
}

export function configuredProviderModels(
  prefix: string,
  defaultModel: string
): string[] {
  return parseProviderModels(
    nonEmpty(getOptionalEnv(`${prefix}_MODELS`)),
    defaultModel
  );
}

export function dedupeModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

export function modelInfoFromId(
  id: string,
  meta: StaticModelMeta,
  raw?: Record<string, unknown>
): ModelInfo {
  const info: ModelInfo = {
    id,
    name: id,
    contextWindow: meta.contextWindow,
    supportsTools: meta.supportsTools,
    supportsVision: meta.supportsVision,
  };
  if (meta.maxOutputTokens !== undefined) info.maxOutputTokens = meta.maxOutputTokens;
  if (raw !== undefined) info.raw = raw;
  return info;
}

export function mergeLiveAndConfiguredModels(
  liveModels: WireModel[],
  configuredModels: string[],
  metaFor: (id: string) => StaticModelMeta
): ModelInfo[] {
  const liveIds = liveModels.map((model) => model.id).filter(Boolean);
  const ids = dedupeModels([...liveIds, ...configuredModels]);
  return ids.map((id): ModelInfo => {
    const raw = liveModels.find((model) => model.id === id);
    return modelInfoFromId(id, metaFor(id), raw as Record<string, unknown> | undefined);
  });
}
