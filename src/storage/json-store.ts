/**
 * storage/json-store.ts
 * Atomic JSON file store — collection (records) + flat KV store.
 * All operations return Result<T> and never throw.
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { JsonValue, Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:json-store');

// ─── Types ────────────────────────────────────────────────────────────────────

export type StoreRecord = { id: string } & Record<string, JsonValue>;

export interface JsonStoreOptions {
  /** Absolute path to the directory that holds all store files. */
  dataDir: string;
  /** Whether to pretty-print written JSON (default: true). */
  pretty?: boolean;
}

export interface KVStoreOptions {
  dataDir: string;
  /** File name without extension (default: "settings"). */
  fileName?: string;
  pretty?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Write via tmp-file then rename for atomic write. */
async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await ensureDir(dirname(filePath));
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, filePath);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * CONCURRENCY FIX [D1]: serializes async critical sections per store instance.
 *
 * 1. `this._queue = this._queue.then(fn)` is not enough by itself because a rejected
 *    `fn()` would make `_queue` reject forever. The continuation below always
 *    resolves, so later writes still run after a failed write.
 *
 * 2. Ten simultaneous writes create ten pending Promise continuations at peak. That
 *    is acceptable for this local JSON store and prevents lost load-modify-save writes.
 */
class AsyncMutex {
  private _queue: Promise<void> = Promise.resolve();

  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._queue.then(fn, fn);
    this._queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

// ─── JsonStore ────────────────────────────────────────────────────────────────

/** Single-file collection store. File format: `{ records: { [id]: T } }` */
export class JsonStore<T extends StoreRecord> {
  private readonly filePath: string;
  private readonly pretty: boolean;
  private readonly mutex = new AsyncMutex(); // CONCURRENCY FIX [D2]

  constructor(collectionName: string, { dataDir, pretty = true }: JsonStoreOptions) {
    this.filePath = join(dataDir, `${collectionName}.json`);
    this.pretty = pretty;
  }

  private async load(): Promise<Map<string, T>> {
    const data = await readJsonFile<{ records: Record<string, T> }>(this.filePath);
    if (!data?.records) return new Map();
    return new Map(Object.entries(data.records));
  }

  private async save(records: Map<string, T>): Promise<void> {
    const payload = {
      records: Object.fromEntries(records),
      _meta: { count: records.size, updatedAt: new Date().toISOString() },
    };
    const out = this.pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
    await atomicWrite(this.filePath, out);
  }

  async get(id: string): Promise<Result<T | null>> {
    try {
      const records = await this.load();
      return { ok: true, value: records.get(id) ?? null };
    } catch (cause) {
      return { ok: false, error: new Error(`get(${id}): ${String(cause)}`) };
    }
  }

  async list(): Promise<Result<T[]>> {
    try {
      const records = await this.load();
      return { ok: true, value: [...records.values()] };
    } catch (cause) {
      return { ok: false, error: new Error(`list(): ${String(cause)}`) };
    }
  }

  async set(record: T): Promise<Result<T>> {
    return this.mutex.acquire(async () => {
      try {
        const records = await this.load();
        records.set(record.id, record);
        await this.save(records);
        logger.debug('set', { id: record.id });
        return { ok: true, value: record };
      } catch (cause) {
        return { ok: false, error: new Error(`set(${record.id}): ${String(cause)}`) };
      }
    });
  }

  async patch(id: string, partial: Partial<Omit<T, 'id'>>): Promise<Result<T>> {
    return this.mutex.acquire(async () => {
      try {
        const records = await this.load();
        const existing = records.get(id);
        if (!existing) return { ok: false, error: new Error(`patch: "${id}" not found`) };
        const updated = { ...existing, ...partial } as T;
        records.set(id, updated);
        await this.save(records);
        return { ok: true, value: updated };
      } catch (cause) {
        return { ok: false, error: new Error(`patch(${id}): ${String(cause)}`) };
      }
    });
  }

  async delete(id: string): Promise<Result<boolean>> {
    return this.mutex.acquire(async () => {
      try {
        const records = await this.load();
        const existed = records.delete(id);
        if (existed) await this.save(records);
        return { ok: true, value: existed };
      } catch (cause) {
        return { ok: false, error: new Error(`delete(${id}): ${String(cause)}`) };
      }
    });
  }

  async clear(): Promise<Result<void>> {
    return this.mutex.acquire(async () => {
      try {
        await this.save(new Map());
        return { ok: true, value: undefined };
      } catch (cause) {
        return { ok: false, error: new Error(`clear(): ${String(cause)}`) };
      }
    });
  }

  async count(): Promise<Result<number>> {
    try {
      const records = await this.load();
      return { ok: true, value: records.size };
    } catch (cause) {
      return { ok: false, error: new Error(`count(): ${String(cause)}`) };
    }
  }

  fileExists(): boolean {
    return existsSync(this.filePath);
  }
}

// ─── KVStore ──────────────────────────────────────────────────────────────────

/** Flat key→value store for settings and simple persistent state. */
export class KVStore {
  private readonly filePath: string;
  private readonly pretty: boolean;
  private readonly mutex = new AsyncMutex(); // CONCURRENCY FIX [D3]

  constructor({ dataDir, fileName = 'settings', pretty = true }: KVStoreOptions) {
    this.filePath = join(dataDir, `${fileName}.json`);
    this.pretty = pretty;
  }

  private async load(): Promise<Record<string, JsonValue>> {
    return (await readJsonFile<Record<string, JsonValue>>(this.filePath)) ?? {};
  }

  private async save(data: Record<string, JsonValue>): Promise<void> {
    const out = this.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    await atomicWrite(this.filePath, out);
  }

  async get<T extends JsonValue>(key: string): Promise<Result<T | null>> {
    try {
      const data = await this.load();
      const value = key in data ? (data[key] as T) : null;
      return { ok: true, value };
    } catch (cause) {
      return { ok: false, error: new Error(`kv.get(${key}): ${String(cause)}`) };
    }
  }

  async set(key: string, value: JsonValue): Promise<Result<void>> {
    return this.mutex.acquire(async () => {
      try {
        const data = await this.load();
        data[key] = value;
        await this.save(data);
        return { ok: true, value: undefined };
      } catch (cause) {
        return { ok: false, error: new Error(`kv.set(${key}): ${String(cause)}`) };
      }
    });
  }

  async delete(key: string): Promise<Result<boolean>> {
    return this.mutex.acquire(async () => {
      try {
        const data = await this.load();
        const existed = key in data;
        if (existed) {
          delete data[key];
          await this.save(data);
        }
        return { ok: true, value: existed };
      } catch (cause) {
        return { ok: false, error: new Error(`kv.delete(${key}): ${String(cause)}`) };
      }
    });
  }

  async all(): Promise<Result<Record<string, JsonValue>>> {
    try {
      return { ok: true, value: { ...(await this.load()) } };
    } catch (cause) {
      return { ok: false, error: new Error(`kv.all(): ${String(cause)}`) };
    }
  }
}
