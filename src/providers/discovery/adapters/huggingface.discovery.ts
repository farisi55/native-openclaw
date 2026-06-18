import { getEnvInt, getOptionalEnv } from '../../../config/env';
import type { ProviderModelDiscoveryAdapter, ProviderModelInfo } from '../model-discovery.types';
import { ModelDiscoveryError } from '../model-discovery.types';
import {
  envEnabled,
  fetchJsonForDiscovery,
  nonEmpty,
  safeNumber,
  safeString,
  safeStringArray,
  splitCsv,
} from './common';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MODELS = 200;
const DEFAULT_LIMIT_PER_PROVIDER = 50;
const DEFAULT_PROVIDERS = [
  'hf-inference',
  'fireworks-ai',
  'groq',
  'cerebras',
  'cohere',
  'novita',
  'together',
  'sambanova',
  'deepinfra',
];
const DEFAULT_PIPELINE_TAGS = ['text-generation', 'conversational'];

interface HuggingFaceModel {
  id?: unknown;
  modelId?: unknown;
  pipeline_tag?: unknown;
  tags?: unknown;
  downloads?: unknown;
  likes?: unknown;
  inferenceProviderMapping?: unknown;
  [key: string]: unknown;
}

function apiKey(): string | undefined {
  return nonEmpty(getOptionalEnv('HUGGINGFACE_API_KEY')) ??
    nonEmpty(getOptionalEnv('HF_API_KEY')) ??
    nonEmpty(getOptionalEnv('HF_TOKEN'));
}

function routerModelId(modelId: string, provider: string): string {
  if (provider === 'hf-inference') return modelId;
  if (modelId.includes(':')) return modelId;
  return `${modelId}:${provider}`;
}

function isChatCapable(model: HuggingFaceModel): boolean {
  const pipeline = safeString(model.pipeline_tag)?.toLowerCase() ?? '';
  const tags = safeStringArray(model.tags)?.join(' ').toLowerCase() ?? '';
  const text = `${pipeline} ${tags}`;
  if (text.includes('embedding') || text.includes('feature-extraction')) return false;
  if (!text) return true;
  return text.includes('text-generation') ||
    text.includes('conversational') ||
    text.includes('text2text-generation') ||
    text.includes('chat');
}

export class HuggingFaceDiscoveryAdapter implements ProviderModelDiscoveryAdapter {
  readonly providerId = 'huggingface';

  isEnabled(): boolean {
    return envEnabled(getOptionalEnv('HUGGINGFACE_DISCOVERY_ENABLED'), true) &&
      Boolean(apiKey());
  }

  disabledReason(): string | null {
    if (!envEnabled(getOptionalEnv('HUGGINGFACE_DISCOVERY_ENABLED'), true)) {
      return 'HUGGINGFACE_DISCOVERY_ENABLED=false.';
    }
    return apiKey() ? null : 'Missing HUGGINGFACE_API_KEY, HF_API_KEY, or HF_TOKEN.';
  }

  async refresh(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const token = apiKey();
    if (!token) {
      throw new ModelDiscoveryError(
        this.providerId,
        'DISCOVERY_AUTH_ERROR',
        'Missing HUGGINGFACE_API_KEY, HF_API_KEY, or HF_TOKEN.',
        false
      );
    }

    const providers = splitCsv(getOptionalEnv('HUGGINGFACE_DISCOVERY_PROVIDERS'), DEFAULT_PROVIDERS);
    const pipelineTags = splitCsv(getOptionalEnv('HUGGINGFACE_DISCOVERY_PIPELINE_TAGS'), DEFAULT_PIPELINE_TAGS);
    const limitPerProvider = getEnvInt('HUGGINGFACE_DISCOVERY_LIMIT_PER_PROVIDER', DEFAULT_LIMIT_PER_PROVIDER);
    const maxModels = getEnvInt('PROVIDER_MODEL_DISCOVERY_MAX_MODELS_PER_PROVIDER', DEFAULT_MAX_MODELS);
    const timeoutMs = getEnvInt('PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const discoveredAt = new Date().toISOString();
    const models: ProviderModelInfo[] = [];
    const seen = new Set<string>();

    for (const inferenceProvider of providers) {
      for (const pipelineTag of pipelineTags) {
        if (models.length >= maxModels) break;
        const url = new URL('https://huggingface.co/api/models');
        url.searchParams.set('inference_provider', inferenceProvider);
        url.searchParams.set('pipeline_tag', pipelineTag);
        url.searchParams.set('limit', String(limitPerProvider));
        url.searchParams.set('full', 'true');

        const data = await fetchJsonForDiscovery<HuggingFaceModel[]>(
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

        if (!Array.isArray(data)) {
          throw new ModelDiscoveryError(
            this.providerId,
            'DISCOVERY_INVALID_RESPONSE',
            'Hugging Face Hub returned an invalid models response.',
            false
          );
        }

        for (const model of data) {
          if (!isChatCapable(model)) continue;
          const rawId = safeString(model.id) ?? safeString(model.modelId);
          if (!rawId) continue;
          const id = routerModelId(rawId, inferenceProvider);
          if (seen.has(id)) continue;
          seen.add(id);
          const info: ProviderModelInfo = {
            id,
            providerId: this.providerId,
            displayName: rawId,
            source: 'discovered',
            status: 'unknown',
            lastDiscoveredAt: discoveredAt,
            inputModalities: ['text'],
            outputModalities: ['text'],
            raw: {
              ...model,
              nativeOpenClawInferenceProvider: inferenceProvider,
              nativeOpenClawPipelineTag: pipelineTag,
            },
          };
          const contextWindow = safeNumber((model as Record<string, unknown>)['context_length']);
          if (contextWindow !== undefined) info.contextWindow = contextWindow;
          models.push(info);
          if (models.length >= maxModels) break;
        }
      }
    }

    return models;
  }
}

