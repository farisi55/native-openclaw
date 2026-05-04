/**
 * providers/index.ts
 * Barrel — re-exports all providers and exposes createProviderRegistry().
 *
 * Registry population is driven by which API keys are present in the
 * validated AppConfig. Providers with missing keys are silently skipped.
 * Ollama is always attempted (it needs no API key).
 */

import type { AppConfig } from '../config';
import type { ProviderRegistry } from '../types/provider';
import { createLogger } from '../utils/logger';

export { BaseProvider } from './base';
export { OllamaProvider } from './ollama';
export { OpenRouterProvider } from './openrouter';
export { GroqProvider } from './groq';
export { MistralProvider } from './mistral';

const logger = createLogger('providers');

/**
 * Instantiate all configured providers and return a registry map.
 *
 * Providers are registered by their `id` string (e.g. "groq", "ollama").
 * Instantiation failures are caught and logged — they do not abort startup.
 *
 * @param config - Validated AppConfig from Part 1.
 * @returns       ProviderRegistry (Map<string, IProvider>)
 */
export async function createProviderRegistry(
  config: AppConfig
): Promise<ProviderRegistry> {
  const registry: ProviderRegistry = new Map();

  // ── Ollama ────────────────────────────────────────────────────────────────
  // Always attempt to register Ollama — no key required.
  await tryRegister(registry, async () => {
    const { OllamaProvider } = await import('./ollama');
    return new OllamaProvider();
  }, 'ollama');

  // ── OpenRouter ────────────────────────────────────────────────────────────
  if (process.env['OPENROUTER_API_KEY']) {
    await tryRegister(registry, async () => {
      const { OpenRouterProvider } = await import('./openrouter');
      return new OpenRouterProvider();
    }, 'openrouter');
  }

  // ── Groq ──────────────────────────────────────────────────────────────────
  if (process.env['GROQ_API_KEY']) {
    await tryRegister(registry, async () => {
      const { GroqProvider } = await import('./groq');
      return new GroqProvider();
    }, 'groq');
  }

  // ── Mistral ───────────────────────────────────────────────────────────────
  if (process.env['MISTRAL_API_KEY']) {
    await tryRegister(registry, async () => {
      const { MistralProvider } = await import('./mistral');
      return new MistralProvider();
    }, 'mistral');
  }

  if (registry.size === 0) {
    logger.warn(
      'No providers registered. Set at least one API key or ensure Ollama is running.'
    );
  } else {
    logger.info(`Registered providers: ${[...registry.keys()].join(', ')}`);
  }

  // Suppress unused-variable warning — config is reserved for future
  // provider-specific overrides (e.g. custom base URLs from AppConfig).
  void config;

  return registry;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

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
