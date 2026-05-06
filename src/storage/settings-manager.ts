/**
 * storage/settings-manager.ts
 * Persists user preferences to settings.json.
 * v5: adds per-provider default model map (defaultModels).
 */

import { join } from 'path';
import { KVStore } from './json-store';
import type { JsonValue, Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:settings');

export interface AppSettings {
  defaultProvider?: string;
  /** Single default model (legacy / single-provider usage). */
  defaultModel?: string;
  /** Per-provider default models. Takes precedence over defaultModel. */
  defaultModels?: Record<string, string>;
  [key: string]: JsonValue | undefined;
}

/** Built-in fallback defaults — used when no settings.json entry exists. */
const BUILTIN_DEFAULTS: Record<string, string> = {
  ollama:      'qwen2.5:1.5b',
  groq:        'llama-3.1-8b-instant',
  mistral:     'mistral-small-latest',
  openrouter:  'liquid/lfm-2.5-1.2b-instruct:free',
  gemini:      'gemini-1.5-flash',
  openai:      'gpt-4o-mini',
  anthropic:   'claude-3-haiku-20240307',
};

export class SettingsManager {
  private readonly kv: KVStore;

  constructor(dataDir: string) {
    this.kv = new KVStore({ dataDir, fileName: 'settings' });
    logger.debug('settings store initialised', { path: join(dataDir, 'settings.json') });
  }

  async get<T extends JsonValue>(key: string): Promise<T | null> {
    const r = await this.kv.get<T>(key);
    return r.ok ? r.value : null;
  }

  async set(key: string, value: JsonValue): Promise<Result<void>> {
    return this.kv.set(key, value);
  }

  async getDefaultProvider(): Promise<string | null> {
    return this.get<string>('defaultProvider');
  }

  async getDefaultModel(): Promise<string | null> {
    return this.get<string>('defaultModel');
  }

  // ── Per-provider default model ─────────────────────────────────────────────

  /**
   * Get the default model for a specific provider.
   * Resolution order:
   *   1. settings.json → defaultModels[providerId]
   *   2. settings.json → defaultModel  (if provider matches defaultProvider)
   *   3. BUILTIN_DEFAULTS[providerId]
   *   4. null (caller must fallback to listModels()[0])
   */
  async getDefaultModelForProvider(providerId: string): Promise<string | null> {
    const all = await this.all();

    // 1. Per-provider map
    const perProviderMap = all.defaultModels as Record<string, string> | undefined;
    if (perProviderMap && perProviderMap[providerId]) {
      return perProviderMap[providerId]!;
    }

    // 2. Legacy single default (only if it was set for this provider)
    if (all.defaultModel && all.defaultProvider === providerId) {
      return all.defaultModel;
    }

    // 3. Built-in fallback
    return BUILTIN_DEFAULTS[providerId] ?? null;
  }

  /**
   * Set the default model for a specific provider.
   * Updates the defaultModels map in settings.json.
   */
  async setDefaultModelForProvider(providerId: string, model: string): Promise<void> {
    const all = await this.all();
    const existing = (all.defaultModels as Record<string, string> | undefined) ?? {};
    existing[providerId] = model;
    await this.kv.set('defaultModels', existing);
    // Also update the flat defaultModel for backwards compat
    await this.kv.set('defaultModel', model);
    await this.kv.set('defaultProvider', providerId);
    logger.info('per-provider default model saved', { providerId, model });
  }

  async setDefaultProvider(providerId: string): Promise<void> {
    await this.kv.set('defaultProvider', providerId);
    logger.info('default provider saved', { providerId });
  }

  async setDefaultModel(model: string): Promise<void> {
    await this.kv.set('defaultModel', model);
    logger.info('default model saved', { model });
  }

  async all(): Promise<AppSettings> {
    const r = await this.kv.all();
    return (r.ok ? r.value : {}) as AppSettings;
  }
}
