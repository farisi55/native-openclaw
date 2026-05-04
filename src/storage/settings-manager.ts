/**
 * storage/settings-manager.ts
 * Persists user preferences (default provider, default model, etc.)
 * to settings.json via KVStore.
 */

import { join } from 'path';
import { KVStore } from './json-store';
import type { JsonValue, Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:settings');

export interface AppSettings {
  defaultProvider?: string;
  defaultModel?: string;
  [key: string]: JsonValue | undefined;
}

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

  async setDefaultProvider(providerId: string): Promise<void> {
    await this.kv.set('defaultProvider', providerId);
    logger.info('default provider saved', { providerId });
  }

  async setDefaultModel(model: string): Promise<void> {
    await this.kv.set('defaultModel', model);
    logger.info('default model saved', { model });
  }

  /** Load all settings as a flat object. */
  async all(): Promise<AppSettings> {
    const r = await this.kv.all();
    return (r.ok ? r.value : {}) as AppSettings;
  }
}
