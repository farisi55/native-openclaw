/**
 * providers/index.ts
 * Registry factory — instantiates all configured providers.
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

const logger = createLogger('providers');

export async function createProviderRegistry(
  config: AppConfig
): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = new Map();

  // Ollama — always attempted (no key required)
  await tryRegister(registry, async () => {
    const { OllamaProvider } = await import('./ollama');
    return new OllamaProvider();
  }, 'ollama');

  if (process.env['OPENROUTER_API_KEY']) {
    await tryRegister(registry, async () => {
      const { OpenRouterProvider } = await import('./openrouter');
      return new OpenRouterProvider();
    }, 'openrouter');
  }

  if (process.env['GROQ_API_KEY']) {
    await tryRegister(registry, async () => {
      const { GroqProvider } = await import('./groq');
      return new GroqProvider();
    }, 'groq');
  }

  if (process.env['MISTRAL_API_KEY']) {
    await tryRegister(registry, async () => {
      const { MistralProvider } = await import('./mistral');
      return new MistralProvider();
    }, 'mistral');
  }

  // Gemini — registered if API key is present
  if (process.env['GEMINI_API_KEY']) {
    await tryRegister(registry, async () => {
      const { GeminiProvider } = await import('./gemini');
      return new GeminiProvider();
    }, 'gemini');
  }

  if (registry.size === 0) {
    logger.warn('No providers registered. Set at least one API key or ensure Ollama is running.');
  } else {
    logger.info(`Registered providers: ${[...registry.keys()].join(', ')}`);
  }

  void config;
  return registry;
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
