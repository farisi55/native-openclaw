import type { ProviderModelInfo } from './model-discovery.types';

function model(input: Omit<ProviderModelInfo, 'source' | 'status'>): ProviderModelInfo {
  return {
    ...input,
    source: 'curated',
    status: 'unknown',
  };
}

export const CURATED_PROVIDER_MODELS: Record<string, ProviderModelInfo[]> = {
  'github-models': [
    model({
      id: 'openai/gpt-4.1',
      providerId: 'github-models',
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
    model({
      id: 'openai/gpt-4.1-mini',
      providerId: 'github-models',
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
  ],
  huggingface: [
    model({
      id: 'openai/gpt-oss-120b:fastest',
      providerId: 'huggingface',
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
    model({
      id: 'meta-llama/Llama-3.1-8B-Instruct:fireworks-ai',
      providerId: 'huggingface',
      supportsTools: false,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
  ],
  cohere: [
    model({
      id: 'command-a-plus-05-2026',
      providerId: 'cohere',
      contextWindow: 256_000,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
  ],
  cloudflare: [
    model({
      id: '@cf/moonshotai/kimi-k2.7-code',
      providerId: 'cloudflare',
      displayName: 'Kimi K2.7 Code',
      contextWindow: 262_100,
      supportsTools: true,
      supportsVision: true,
      supportsJsonMode: true,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    }),
    model({
      id: '@cf/zai-org/glm-4.7-flash',
      providerId: 'cloudflare',
      displayName: 'GLM-4.7 Flash',
      contextWindow: 131_072,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
    model({
      id: '@cf/openai/gpt-oss-120b',
      providerId: 'cloudflare',
      displayName: 'gpt-oss-120b',
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
    model({
      id: '@cf/meta/llama-3.1-8b-instruct',
      providerId: 'cloudflare',
      contextWindow: 128_000,
      supportsTools: true,
      supportsVision: false,
      inputModalities: ['text'],
      outputModalities: ['text'],
    }),
  ],
};

export function curatedModelsFor(providerId: string): ProviderModelInfo[] {
  return [...(CURATED_PROVIDER_MODELS[providerId] ?? [])];
}

