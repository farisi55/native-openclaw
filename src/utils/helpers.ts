/**
 * utils/helpers.ts
 * General-purpose utilities: ID generation, JSON persistence stubs, misc.
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { JsonValue, Result } from '../types/global';

// ─── ID Generation ────────────────────────────────────────────────────────────

/**
 * Generate a RFC 4122 v4 UUID.
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * Generate a short ID (first 8 chars of a UUID, no dashes).
 * Suitable for display, NOT guaranteed unique at large scale.
 */
export function generateShortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/**
 * Generate a prefixed ID, e.g. "msg_a1b2c3d4".
 */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${generateShortId()}`;
}

// ─── Timing ───────────────────────────────────────────────────────────────────

/** Return current epoch in milliseconds. */
export function now(): number {
  return Date.now();
}

/** Return ISO 8601 timestamp string. */
export function isoNow(): string {
  return new Date().toISOString();
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Safe JSON Read ───────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file from disk.
 *
 * @returns Result<T> — never throws.
 */
export async function safeReadJson<T = JsonValue>(
  filePath: string
): Promise<Result<T>> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as T;
    return { ok: true, value: parsed };
  } catch (cause) {
    const message =
      cause instanceof SyntaxError
        ? `JSON parse error in "${filePath}": ${cause.message}`
        : `Could not read "${filePath}": ${String(cause)}`;
    return { ok: false, error: new Error(message) };
  }
}

// ─── Safe JSON Write ──────────────────────────────────────────────────────────

/**
 * Serialize and write a value to a JSON file.
 * Creates parent directories automatically.
 *
 * @returns Result<void> — never throws.
 */
export async function safeWriteJson(
  filePath: string,
  data: JsonValue,
  pretty = true
): Promise<Result<void>> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const serialized = pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    await writeFile(filePath, serialized, 'utf-8');
    return { ok: true, value: undefined };
  } catch (cause) {
    return {
      ok: false,
      error: new Error(`Could not write "${filePath}": ${String(cause)}`),
    };
  }
}

// ─── String Utilities ─────────────────────────────────────────────────────────

/** Truncate a string to `maxLen` characters, appending an ellipsis. */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/** Strip ANSI escape codes from a string. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

// ─── Object Utilities ─────────────────────────────────────────────────────────

/** Remove keys with undefined values from an object (shallow). */
export function omitUndefined<T extends Record<string, unknown>>(
  obj: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** Pick specified keys from an object. */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[]
): Pick<T, K> {
  return Object.fromEntries(
    keys.filter((k) => k in obj).map((k) => [k, obj[k]])
  ) as Pick<T, K>;
}
