/**
 * storage/settings-manager.ts
 * v8: adds router config persistence.
 */

import { join } from 'path';
import { KVStore } from './json-store';
import type { JsonValue, Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:settings');

export interface AppSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultModels?: Record<string, string>;
  routerEnabled?: boolean;
  autoFallback?: boolean;
  autoSwitch?: boolean;
  [key: string]: JsonValue | undefined;
}

const BUILTIN_DEFAULTS: Record<string, string> = {
  ollama:      'qwen2.5:1.5b',
  groq:        'llama-3.1-8b-instant',
  mistral:     'mistral-small-latest',
  openrouter:  'liquid/lfm-2.5-1.2b-instruct:free',
  gemini:      'gemini-1.5-flash',
  sambanova:   'Meta-Llama-3.1-70B-Instruct',
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

  async getDefaultModelForProvider(providerId: string): Promise<string | null> {
    const all = await this.all();
    const perProviderMap = all.defaultModels as Record<string, string> | undefined;
    if (perProviderMap?.[providerId]) return perProviderMap[providerId]!;
    if (all.defaultModel && all.defaultProvider === providerId) return all.defaultModel;
    return BUILTIN_DEFAULTS[providerId] ?? null;
  }

  async setDefaultModelForProvider(providerId: string, model: string): Promise<void> {
    const all = await this.all();
    const existing = (all.defaultModels as Record<string, string> | undefined) ?? {};
    existing[providerId] = model;
    await this.kv.set('defaultModels', existing);
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

  async getRouterEnabled(): Promise<boolean> {
    const v = await this.get<boolean>('routerEnabled');
    // Default from env, then true
    if (v !== null) return v;
    return process.env['ROUTER_ENABLED'] !== 'false';
  }

  async getAutoFallback(): Promise<boolean> {
    const v = await this.get<boolean>('autoFallback');
    if (v !== null) return v;
    return process.env['AUTO_FALLBACK'] !== 'false';
  }

  async all(): Promise<AppSettings> {
    const r = await this.kv.all();
    return (r.ok ? r.value : {}) as AppSettings;
  }
}
