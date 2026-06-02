/**
 * storage/memory-manager.ts
 * Persistent memory store for agent identity and learned facts.
 *
 * File layout (data/memory.json):
 * {
 *   "global": { "agentName": "Jarpis", ... },
 *   "sessions": { "<sessionId>": { "facts": { ... } } }
 * }
 *
 * All writes are atomic. All reads are safe (never throw).
 */

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { normalizeUserNameCandidate } from '../memory/user-name';

const logger = createLogger('storage:memory');

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryValue = string | number | boolean | null;

export interface GlobalMemory {
  agentName?: string;
  [key: string]: MemoryValue | undefined;
}

export interface SessionMemory {
  facts: Record<string, MemoryValue>;
}

export interface MemoryStore {
  global: GlobalMemory;
  sessions: Record<string, SessionMemory>;
}

export interface BuildMemoryBlockOptions {
  minimal?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_STORE: MemoryStore = { global: {}, sessions: {} };

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, filePath);
}

async function readStore(filePath: string): Promise<MemoryStore> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MemoryStore>;
    return {
      global: parsed.global ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch {
    return { ...EMPTY_STORE, global: {}, sessions: {} };
  }
}

async function writeStore(filePath: string, store: MemoryStore): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(store, null, 2));
}

// ─── MemoryManager ────────────────────────────────────────────────────────────

export class MemoryManager {
  private readonly filePath: string;
  /** In-memory cache to avoid redundant disk reads within a session. */
  private cache: MemoryStore | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'memory.json');
    logger.debug('memory store initialised', { path: this.filePath });
  }

  // ── Internal load/save ─────────────────────────────────────────────────────

  private async load(): Promise<MemoryStore> {
    if (this.cache) return this.cache;
    this.cache = await readStore(this.filePath);
    return this.cache;
  }

  private async save(store: MemoryStore): Promise<void> {
    this.cache = store;
    await writeStore(this.filePath, store);
  }

  // ── Global memory ──────────────────────────────────────────────────────────

  async getGlobalMemory(): Promise<GlobalMemory> {
    const store = await this.load();
    return { ...store.global };
  }

  async setGlobalMemory(key: string, value: MemoryValue): Promise<void> {
    const store = await this.load();
    store.global[key] = value;
    await this.save(store);
    logger.debug('global memory set', { key, value });
  }

  async getGlobalValue(key: string): Promise<MemoryValue | undefined> {
    const store = await this.load();
    return store.global[key];
  }

  /** Delete a single global key. */
  async deleteGlobalMemory(key: string): Promise<void> {
    const store = await this.load();
    delete store.global[key];
    await this.save(store);
  }

  // ── Session memory ─────────────────────────────────────────────────────────

  async getSessionMemory(sessionId: string): Promise<SessionMemory> {
    const store = await this.load();
    return { facts: { ...(store.sessions[sessionId]?.facts ?? {}) } };
  }

  async setSessionMemory(
    sessionId: string,
    key: string,
    value: MemoryValue
  ): Promise<void> {
    const store = await this.load();
    if (!store.sessions[sessionId]) {
      store.sessions[sessionId] = { facts: {} };
    }
    store.sessions[sessionId]!.facts[key] = value;
    await this.save(store);
    logger.debug('session memory set', { sessionId, key, value });
  }

  async deleteSessionMemory(sessionId: string): Promise<void> {
    const store = await this.load();
    delete store.sessions[sessionId];
    await this.save(store);
  }

  // ── Serialise for prompt injection ────────────────────────────────────────

  /**
   * Build a human-readable MEMORY block for prompt injection.
   * Returns null if no memory facts exist.
   */
  async buildMemoryBlock(sessionId?: string, options: BuildMemoryBlockOptions = {}): Promise<string | null> {
    const store = await this.load();
    const lines: string[] = [];
    const minimal = options.minimal ?? false;

    // Global facts
    const global = store.global;
    if (global.agentName) {
      lines.push(`- Your name is ${global.agentName}`);
    }
    if (!minimal) {
      for (const [k, v] of Object.entries(global)) {
        if (k === 'agentName') continue; // already added above
        if (v !== null && v !== undefined) {
          lines.push(`- ${k}: ${String(v)}`);
        }
      }
    }

    // Session-specific facts
    if (sessionId) {
      const sess = store.sessions[sessionId];
      if (sess?.facts) {
        for (const [k, v] of Object.entries(sess.facts)) {
          if (k === 'userName') {
            const validName = normalizeUserNameCandidate(v);
            if (validName) {
              lines.push(`- [this session] userName: ${validName}`);
            } else {
              logger.warn('ignored invalid stored userName', {
                sessionId,
                value: typeof v === 'string' ? v : String(v),
              });
            }
            continue;
          }
          if (minimal) continue;
          if (v !== null && v !== undefined) {
            lines.push(`- [this session] ${k}: ${String(v)}`);
          }
        }
      }
    }

    if (lines.length === 0) return null;

    return ['## MEMORY', '> These facts were learned from previous conversations. Always honour them.', '', ...lines, ''].join('\n');
  }

  /** Invalidate in-memory cache (force re-read from disk on next access). */
  invalidateCache(): void {
    this.cache = null;
  }
}
