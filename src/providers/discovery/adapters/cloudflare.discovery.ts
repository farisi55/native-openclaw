import { getEnvBool, getEnvInt, getOptionalEnv } from '../../../config/env';
import type { ProviderModelDiscoveryAdapter, ProviderModelInfo } from '../model-discovery.types';
import { ModelDiscoveryError } from '../model-discovery.types';
import {
  fetchJsonForDiscovery,
  nonEmpty,
  safeNumber,
  safeString,
  safeStringArray,
} from './common';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MODELS = 200;

interface CloudflareModel {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  task?: unknown;
  task_type?: unknown;
  description?: unknown;
  properties?: unknown;
  tags?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  [key: string]: unknown;
}

interface CloudflareModelsResponse {
  success?: unknown;
  result?: unknown;
  errors?: unknown;
}

function apiKey(): string | undefined {
  return nonEmpty(getOptionalEnv('CLOUDFLARE_API_KEY'));
}

function accountId(): string | undefined {
  return nonEmpty(getOptionalEnv('CLOUDFLARE_ACCOUNT_ID'));
}

function modelId(model: CloudflareModel): string | undefined {
  const id = safeString(model.id) ?? safeString(model.name) ?? safeString(model.model);
  if (!id) return undefined;
  if (id.startsWith('@')) return id;
  return `@cf/${id.replace(/^\/+/, '')}`;
}

function isChatCapable(model: CloudflareModel): boolean {
  const fields = [
    safeString(model.task),
    safeString(model.task_type),
    safeString(model.description),
    safeStringArray(model.tags)?.join(' '),
    JSON.stringify(model.properties ?? {}),
  ].filter(Boolean).join(' ').toLowerCase();
  if (fields.includes('embedding') || fields.includes('image-classification')) return false;
  if (!fields) return true;
  return fields.includes('text generation') ||
    fields.includes('text-generation') ||
    fields.includes('llm') ||
    fields.includes('chat') ||
    fields.includes('conversation') ||
    fields.includes('code');
}

function extractModels(response: CloudflareModelsResponse): CloudflareModel[] | null {
  const result = response.result;
  if (Array.isArray(result)) return result as CloudflareModel[];
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record['models'])) return record['models'] as CloudflareModel[];
    if (Array.isArray(record['data'])) return record['data'] as CloudflareModel[];
  }
  return null;
}

export class CloudflareDiscoveryAdapter implements ProviderModelDiscoveryAdapter {
  readonly providerId = 'cloudflare';

  isEnabled(): boolean {
    return getEnvBool('CLOUDFLARE_DISCOVERY_ENABLED', false) && Boolean(apiKey() && accountId());
  }

  disabledReason(): string | null {
    if (!getEnvBool('CLOUDFLARE_DISCOVERY_ENABLED', false)) {
      return 'Cloudflare remote model discovery is disabled. Using configured and curated models.';
    }
    if (!apiKey()) return 'Missing CLOUDFLARE_API_KEY.';
    if (!accountId()) return 'Missing CLOUDFLARE_ACCOUNT_ID.';
    return null;
  }

  async refresh(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const token = apiKey();
    const account = accountId();
    if (!token || !account) {
      throw new ModelDiscoveryError(
        this.providerId,
        'DISCOVERY_AUTH_ERROR',
        'Missing CLOUDFLARE_API_KEY or CLOUDFLARE_ACCOUNT_ID.',
        false
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/models`;
    const data = await fetchJsonForDiscovery<CloudflareModelsResponse>(
      this.providerId,
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeoutMs: getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
        ...(signal ? { signal } : {}),
      }
    );

    const rawModels = extractModels(data);
    if (!rawModels) {
      throw new ModelDiscoveryError(
        this.providerId,
        'DISCOVERY_INVALID_RESPONSE',
        'Cloudflare model catalog returned an invalid response.',
        false
      );
    }

    const discoveredAt = new Date().toISOString();
    return rawModels
      .filter(isChatCapable)
      .slice(0, getEnvInt('PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER', DEFAULT_MAX_MODELS))
      .map((model): ProviderModelInfo | null => {
        const id = modelId(model);
        if (!id) return null;
        const info: ProviderModelInfo = {
          id,
          providerId: this.providerId,
          source: 'discovered',
          status: 'unknown',
          lastDiscoveredAt: discoveredAt,
          raw: model,
        };
        const displayName = safeString(model.name) ?? safeString(model.id);
        if (displayName) info.displayName = displayName;
        const contextWindow = safeNumber(model.context_window) ?? safeNumber(model.context_length);
        if (contextWindow !== undefined) info.contextWindow = contextWindow;
        const serialized = JSON.stringify(model).toLowerCase();
        if (serialized.includes('tool') || serialized.includes('function calling')) info.supportsTools = true;
        if (serialized.includes('vision') || serialized.includes('image')) {
          info.supportsVision = true;
          info.inputModalities = ['text', 'image'];
        } else {
          info.inputModalities = ['text'];
        }
        info.outputModalities = ['text'];
        return info;
      })
      .filter((model): model is ProviderModelInfo => model !== null);
  }
}
