/**
 * providers/index.ts
 * Registry factory — instantiates all configured providers.
 * v8: adds SambaNova + Z.ai.
 */

import type { AppConfig } from '../config';
import type { ProviderRegistry } from '../types/provider';
import { createLogger } from '../utils/logger';

export { BaseProvider } from './base';
export { OllamaProvider } from './ollama';
export { OpenRouterProvider } from './openrouter';
export { GroqProvider } from './groq';
export { MistralProvider } from './mistral';
export { GeminiProvider } from './gemini';
export { SambaNovaProvider } from './sambanova';
export { ZaiProvider } from './zai';
export { PuterProvider } from './puter';
export { CloudflareProvider } from './cloudflare';
export { GitHubModelsProvider } from './github-models';
export { HuggingFaceProvider } from './huggingface';
export { CohereProvider } from './cohere';
export {
  parseProviderModels,
  providerDefaultModelFromEnv,
  providerEnvPrefix,
} from './provider-env';

const logger = createLogger('providers');

// FIX: prefix with underscore — suppresses noUnusedParameters cleanly without 'void' hack
export async function createProviderRegistry(_config: AppConfig): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = new Map();

  await tryRegister(registry, async () => {
    const { OllamaProvider } = await import('./ollama.js');
    return new OllamaProvider();
  }, 'ollama');

  if (process.env['OPENROUTER_API_KEY']) {
    await tryRegister(registry, async () => {
      const { OpenRouterProvider } = await import('./openrouter.js');
      return new OpenRouterProvider();
    }, 'openrouter');
  }

  if (process.env['GROQ_API_KEY']) {
    await tryRegister(registry, async () => {
      const { GroqProvider } = await import('./groq.js');
      return new GroqProvider();
    }, 'groq');
  }

  if (process.env['MISTRAL_API_KEY']) {
    await tryRegister(registry, async () => {
      const { MistralProvider } = await import('./mistral.js');
      return new MistralProvider();
    }, 'mistral');
  }

  if (process.env['GEMINI_API_KEY']) {
    await tryRegister(registry, async () => {
      const { GeminiProvider } = await import('./gemini.js');
      return new GeminiProvider();
    }, 'gemini');
  }

  if (process.env['SAMBANOVA_API_KEY']) {
    await tryRegister(registry, async () => {
      const { SambaNovaProvider } = await import('./sambanova.js');
      return new SambaNovaProvider();
    }, 'sambanova');
  }

  if (process.env['ZAI_API_KEY']) {
    await tryRegister(registry, async () => {
      const { ZaiProvider } = await import('./zai.js');
      return new ZaiProvider();
    }, 'zai');
  }

  if (isEnabled(process.env['CLOUDFLARE_AI_ENABLED'])) {
    await tryRegister(registry, async () => {
      const { CloudflareProvider } = await import('./cloudflare.js');
      return new CloudflareProvider();
    }, 'cloudflare');
  }

  if (isEnabled(process.env['HUGGINGFACE_ENABLED'])) {
    await tryRegister(registry, async () => {
      const { HuggingFaceProvider } = await import('./huggingface.js');
      return new HuggingFaceProvider();
    }, 'huggingface');
  }

  if (isEnabled(process.env['COHERE_ENABLED'])) {
    await tryRegister(registry, async () => {
      const { CohereProvider } = await import('./cohere.js');
      return new CohereProvider();
    }, 'cohere');
  }

  if (isEnabled(process.env['GITHUB_MODELS_ENABLED'])) {
    await tryRegister(registry, async () => {
      const { GitHubModelsProvider } = await import('./github-models.js');
      return new GitHubModelsProvider();
    }, 'github-models');
  }

  if (isEnabled(process.env['PUTER_ENABLED'])) {
    await tryRegister(registry, async () => {
      const { PuterProvider } = await import('./puter.js');
      return new PuterProvider();
    }, 'puter');
  }

  if (registry.size === 0) {
    logger.warn('No providers registered. Set at least one API key or ensure Ollama is running.');
  } else {
    logger.info(`Registered providers: ${[...registry.keys()].join(', ')}`);
  }

  return registry;
}

function isEnabled(value: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((value ?? '').trim().toLowerCase());
}

async function tryRegister(
  registry: ProviderRegistry,
  factory: () => Promise<import('../types/provider').IProvider>,
  name: string
): Promise<void> {
  try {
    const provider = await factory();
    registry.set(provider.id, provider);
    logger.debug(`Provider registered: ${provider.displayName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to register provider "${name}": ${message}`);
  }
}
