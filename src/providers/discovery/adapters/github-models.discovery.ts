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

const CATALOG_URL = 'https://models.github.ai/catalog/models';
const DEFAULT_API_VERSION = '2026-03-10';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MODELS = 200;

interface GitHubCatalogModel {
  id?: unknown;
  name?: unknown;
  friendly_name?: unknown;
  display_name?: unknown;
  input_modalities?: unknown;
  output_modalities?: unknown;
  supported_input_modalities?: unknown;
  supported_output_modalities?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_context_length?: unknown;
  rate_limits?: unknown;
  capabilities?: unknown;
  [key: string]: unknown;
}

interface GitHubCatalogResponse {
  data?: GitHubCatalogModel[];
  models?: GitHubCatalogModel[];
}

function apiKey(): string | undefined {
  return nonEmpty(getOptionalEnv('GITHUB_MODELS_API_KEY'));
}

function isChatCapable(model: GitHubCatalogModel): boolean {
  const id = safeString(model.id)?.toLowerCase() ?? '';
  const combined = JSON.stringify(model).toLowerCase();
  if (id.includes('embed') || combined.includes('"embedding"')) return false;
  if (combined.includes('chat') || combined.includes('text')) return true;
  return true;
}

function supportsTools(model: GitHubCatalogModel): boolean | undefined {
  const capabilities = model.capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const text = JSON.stringify(capabilities).toLowerCase();
  if (text.includes('tool') || text.includes('function')) return true;
  return undefined;
}

export class GitHubModelsDiscoveryAdapter implements ProviderModelDiscoveryAdapter {
  readonly providerId = 'github-models';

  isEnabled(): boolean {
    return Boolean(apiKey());
  }

  disabledReason(): string | null {
    return this.isEnabled() ? null : 'Missing GITHUB_MODELS_API_KEY.';
  }

  async refresh(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const token = apiKey();
    if (!token) {
      throw new ModelDiscoveryError(this.providerId, 'DISCOVERY_AUTH_ERROR', 'Missing GITHUB_MODELS_API_KEY.', false);
    }

    const data = await fetchJsonForDiscovery<GitHubCatalogModel[] | GitHubCatalogResponse>(
      this.providerId,
      CATALOG_URL,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': nonEmpty(getOptionalEnv('GITHUB_MODELS_API_VERSION')) ?? DEFAULT_API_VERSION,
        },
        timeoutMs: getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
        ...(signal ? { signal } : {}),
      }
    );

    const rawModels = Array.isArray(data)
      ? data
      : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
      ? data.models
      : null;

    if (!rawModels) {
      throw new ModelDiscoveryError(
        this.providerId,
        'DISCOVERY_INVALID_RESPONSE',
        'GitHub Models catalog returned an invalid response.',
        false
      );
    }

    const discoveredAt = new Date().toISOString();
    return rawModels
      .filter(isChatCapable)
      .slice(0, getEnvInt('PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER', DEFAULT_MAX_MODELS))
      .map((model): ProviderModelInfo | null => {
        const id = safeString(model.id) ?? safeString(model.name);
        if (!id) return null;
        const inputModalities =
          safeStringArray(model.input_modalities) ??
          safeStringArray(model.supported_input_modalities);
        const outputModalities =
          safeStringArray(model.output_modalities) ??
          safeStringArray(model.supported_output_modalities);
        const info: ProviderModelInfo = {
          id,
          providerId: this.providerId,
          source: 'discovered',
          status: 'unknown',
          lastDiscoveredAt: discoveredAt,
          raw: model,
        };
        const displayName = safeString(model.display_name) ?? safeString(model.friendly_name) ?? safeString(model.name);
        if (displayName) info.displayName = displayName;
        const contextWindow =
          safeNumber(model.context_window) ??
          safeNumber(model.context_length) ??
          safeNumber(model.max_context_length);
        if (contextWindow !== undefined) info.contextWindow = contextWindow;
        const tools = supportsTools(model);
        if (tools !== undefined) info.supportsTools = tools;
        if (inputModalities) info.inputModalities = inputModalities;
        if (outputModalities) info.outputModalities = outputModalities;
        if (inputModalities?.includes('image')) info.supportsVision = true;
        if (model.rate_limits && typeof model.rate_limits === 'object') {
          info.rateLimits = model.rate_limits as Record<string, unknown>;
        }
        return info;
      })
      .filter((model): model is ProviderModelInfo => model !== null);
  }
}

