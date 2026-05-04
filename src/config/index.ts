/**
 * config/index.ts
 * Singleton config accessor.
 * Call loadConfig() once at bootstrap; use getConfig() everywhere else.
 */

import { validateConfig } from './validator';
import type { AppConfig } from './validator';

export type { AppConfig, ProviderConfig, AgentConfig, StorageConfig } from './validator';
export { getEnv, getOptionalEnv, getEnvInt, getEnvFloat, getEnvBool } from './env';

let _config: Readonly<AppConfig> | null = null;

/**
 * Initialise and cache the application config.
 * Safe to call multiple times — validation only runs once.
 */
export function loadConfig(): Readonly<AppConfig> {
  if (!_config) {
    _config = validateConfig();
  }
  return _config;
}

/**
 * Retrieve the cached config.
 * @throws If loadConfig() has not been called yet.
 */
export function getConfig(): Readonly<AppConfig> {
  if (!_config) {
    throw new Error(
      '[config] getConfig() called before loadConfig(). ' +
        'Ensure loadConfig() is called in bootstrap.'
    );
  }
  return _config;
}

/** Reset cached config (for use in tests only). */
export function _resetConfig(): void {
  _config = null;
}
