import { getEnvInt, getOptionalEnv } from '../../../config/env';
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
const DEFAULT_LIST_BASE_URL = 'https://api.cohere.com/v1';

interface CohereModel {
  name?: unknown;
  id?: unknown;
  endpoints?: unknown;
  default_endpoints?: unknown;
  features?: unknown;
  context_length?: unknown;
  is_deprecated?: unknown;
  [key: string]: unknown;
}

interface CohereModelsResponse {
  models?: CohereModel[];
  next_page_token?: unknown;
}

function apiKey(): string | undefined {
  return nonEmpty(getOptionalEnv('COHERE_API_KEY'));
}

function discoveryBaseUrl(): string {
  const configured = nonEmpty(getOptionalEnv('COHERE_DISCOVERY_BASE_URL'));
  if (configured) return configured.replace(/\/$/, '');
  const base = nonEmpty(getOptionalEnv('COHERE_BASE_URL'));
  if (!base) return DEFAULT_LIST_BASE_URL;
  return base
    .replace(/\/compatibility\/v1\/?$/i, '/v1')
    .replace(/\/v2\/?$/i, '/v1')
    .replace(/\/$/, '');
}

function isChatCapable(model: CohereModel): boolean {
  const endpoints = safeStringArray(model.endpoints) ?? [];
  const defaultEndpoints = safeStringArray(model.default_endpoints) ?? [];
  const features = safeStringArray(model.features) ?? [];
  const text = [...endpoints, ...defaultEndpoints, ...features].join(' ').toLowerCase();
  if (!text) return true;
  return text.includes('chat') || text.includes('generate') || text.includes('text-generation');
}

export class CohereDiscoveryAdapter implements ProviderModelDiscoveryAdapter {
  readonly providerId = 'cohere';

  isEnabled(): boolean {
    return Boolean(apiKey());
  }

  disabledReason(): string | null {
    return this.isEnabled() ? null : 'Missing COHERE_API_KEY.';
  }

  async refresh(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const token = apiKey();
    if (!token) {
      throw new ModelDiscoveryError(this.providerId, 'DISCOVERY_AUTH_ERROR', 'Missing COHERE_API_KEY.', false);
    }

    const maxModels = getEnvInt('PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER', DEFAULT_MAX_MODELS);
    const timeoutMs = getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const models: CohereModel[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`${discoveryBaseUrl()}/models`);
      url.searchParams.set('page_size', '1000');
      url.searchParams.set('endpoint', 'chat');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const data = await fetchJsonForDiscovery<CohereModelsResponse>(
        this.providerId,
        url.toString(),
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          timeoutMs,
          ...(signal ? { signal } : {}),
        }
      );

      if (!Array.isArray(data.models)) {
        throw new ModelDiscoveryError(
          this.providerId,
          'DISCOVERY_INVALID_RESPONSE',
          'Cohere list models returned an invalid response.',
          false
        );
      }

      models.push(...data.models);
      pageToken = safeString(data.next_page_token);
    } while (pageToken && models.length < maxModels);

    const discoveredAt = new Date().toISOString();
    return models
      .filter(isChatCapable)
      .slice(0, maxModels)
      .map((model): ProviderModelInfo | null => {
        const id = safeString(model.name) ?? safeString(model.id);
        if (!id) return null;
        const features = safeStringArray(model.features);
        const endpoints = safeStringArray(model.endpoints);
        const info: ProviderModelInfo = {
          id,
          providerId: this.providerId,
          displayName: id,
          source: 'discovered',
          status: model.is_deprecated === true ? 'unavailable' : 'unknown',
          lastDiscoveredAt: discoveredAt,
          raw: model,
        };
        const contextWindow = safeNumber(model.context_length);
        if (contextWindow !== undefined) info.contextWindow = contextWindow;
        if (features) info.outputModalities = ['text'];
        if (endpoints || features) info.inputModalities = ['text'];
        if (features?.some((feature) => /tool|function/i.test(feature))) info.supportsTools = true;
        return info;
      })
      .filter((model): model is ProviderModelInfo => model !== null);
  }
}

