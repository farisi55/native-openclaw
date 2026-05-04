/**
 * global.ts
 * Project-wide ambient types and utility generics.
 */

/** Marks a type as JSON-serializable. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Strict Record alias with string keys. */
export type Dict<T = unknown> = Record<string, T>;

/** Makes selected keys required on a type. */
export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

/** Strips undefined from all values in a type. */
export type Defined<T> = { [K in keyof T]-?: NonNullable<T[K]> };

/** Async function type alias. */
export type AsyncFn<TArgs extends unknown[] = [], TReturn = void> = (
  ...args: TArgs
) => Promise<TReturn>;

/** Result type for operations that can fail without throwing. */
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Supported log levels. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Runtime environments. */
export type AppEnv = 'development' | 'production' | 'test';
