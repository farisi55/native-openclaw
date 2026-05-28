/**
 * config/env.ts
 * Loads .env file and exposes a typed, validated raw env accessor.
 */

import { resolve } from 'path';
import { config as loadDotenv } from 'dotenv';

// Load .env relative to the project root (two levels up from src/config/).
const envPath = resolve(process.cwd(), '.env');
const result = loadDotenv({ path: envPath });

if (result.error && process.env['NODE_ENV'] !== 'test') {
  // Not a fatal error — the user may be supplying env vars via CI/shell.
  process.stderr.write(
    `[env] Warning: .env not found at ${envPath}. Falling back to process.env.\n`
  );
}

/**
 * Retrieve a raw environment variable.
 *
 * @param key   - The env var name.
 * @param fallback - Optional default value.
 * @returns The value or fallback.
 * @throws  If neither the env var nor a fallback is available.
 */
export function getEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(
      `[env] Required environment variable "${key}" is not set.`
    );
  }
  return value;
}

/**
 * Retrieve an optional env var.
 * Returns undefined instead of throwing when missing.
 */
export function getOptionalEnv(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

/**
 * Retrieve an env var parsed as integer.
 * Throws if the value is not a valid integer.
 */
export function getEnvInt(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[env] Required env var "${key}" is not set.`);
  }
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`[env] Env var "${key}" must be an integer, got: "${raw}".`);
  }
  return parsed;
}

/**
 * Retrieve an env var parsed as float.
 */
export function getEnvFloat(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[env] Required env var "${key}" is not set.`);
  }
  const parsed = parseFloat(raw);
  if (isNaN(parsed)) {
    throw new Error(`[env] Env var "${key}" must be a number, got: "${raw}".`);
  }
  return parsed;
}

/**
 * Retrieve an env var parsed as boolean.
 * Accepts: "true", "1", "yes" (case-insensitive) → true.
 */
export function getEnvBool(key: string, fallback?: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[env] Required env var "${key}" is not set.`);
  }
  return ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}

export const SELF_IMPROVING = getOptionalEnv('SELF_IMPROVING') === 'true';
export const SELF_IMPROVING_EVAL_THRESHOLD = parseInt(
  getOptionalEnv('SELF_IMPROVING_EVAL_THRESHOLD') ?? '10',
  10
);
