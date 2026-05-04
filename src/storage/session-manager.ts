/**
 * storage/session-manager.ts
 * High-level session CRUD built on top of JsonStore.
 *
 * A Session holds the ordered conversation history, provider/model info,
 * active skill IDs, timestamps, and arbitrary metadata.
 */

import { randomUUID } from 'crypto';
import { JsonStore } from './json-store';
import type { Message } from '../types/message';
import type { JsonValue, Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:sessions');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  messages: Message[];
  providerId: string;
  model: string;
  activeSkills: string[];
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, JsonValue>;
}

// Workaround: JsonStore requires StoreRecord (all values must be JsonValue).
// We cast Session to/from the store — Message is JSON-serializable at runtime.
type StoredSession = { id: string } & Record<string, JsonValue>;

export interface CreateSessionOptions {
  providerId: string;
  model: string;
  activeSkills?: string[];
  metadata?: Record<string, JsonValue>;
}

export interface AppendMessageOptions {
  sessionId: string;
  message: Message;
}

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
  private readonly store: JsonStore<StoredSession>;

  constructor(dataDir: string) {
    this.store = new JsonStore<StoredSession>('sessions', { dataDir });
    logger.debug('session store initialised', { dataDir });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toStored(s: Session): StoredSession {
    return s as unknown as StoredSession;
  }

  private fromStored(s: StoredSession): Session {
    return s as unknown as Session;
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(options: CreateSessionOptions): Promise<Result<Session>> {
    const nowStr = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      messages: [],
      providerId: options.providerId,
      model: options.model,
      activeSkills: options.activeSkills ?? [],
      createdAt: nowStr,
      updatedAt: nowStr,
      metadata: options.metadata ?? {},
    };

    const result = await this.store.set(this.toStored(session));
    if (!result.ok) return { ok: false, error: result.error };

    logger.info('session created', { id: session.id, model: session.model });
    return { ok: true, value: session };
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async get(id: string): Promise<Result<Session | null>> {
    const result = await this.store.get(id);
    if (!result.ok) return { ok: false, error: result.error };
    if (!result.value) return { ok: true, value: null };
    return { ok: true, value: this.fromStored(result.value) };
  }

  async list(): Promise<Result<Session[]>> {
    const result = await this.store.list();
    if (!result.ok) return { ok: false, error: result.error };
    const sessions = result.value
      .map((s) => this.fromStored(s))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return { ok: true, value: sessions };
  }

  // ── Append message ─────────────────────────────────────────────────────────

  async appendMessage(opts: AppendMessageOptions): Promise<Result<Session>> {
    const getResult = await this.get(opts.sessionId);
    if (!getResult.ok) return { ok: false, error: getResult.error };
    if (!getResult.value) {
      return { ok: false, error: new Error(`Session "${opts.sessionId}" not found`) };
    }

    const session = getResult.value;
    const updated: Session = {
      ...session,
      messages: [...session.messages, opts.message],
      updatedAt: new Date().toISOString(),
    };

    const result = await this.store.set(this.toStored(updated));
    if (!result.ok) return { ok: false, error: result.error };

    logger.debug('message appended', {
      sessionId: opts.sessionId,
      role: opts.message.role,
      total: updated.messages.length,
    });
    return { ok: true, value: updated };
  }

  // ── Update metadata ────────────────────────────────────────────────────────

  async updateMetadata(
    id: string,
    metadata: Record<string, JsonValue>
  ): Promise<Result<Session>> {
    const getResult = await this.get(id);
    if (!getResult.ok) return { ok: false, error: getResult.error };
    if (!getResult.value) return { ok: false, error: new Error(`Session "${id}" not found`) };

    const updated: Session = {
      ...getResult.value,
      metadata: { ...getResult.value.metadata, ...metadata },
      updatedAt: new Date().toISOString(),
    };

    const result = await this.store.set(this.toStored(updated));
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, value: updated };
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async delete(id: string): Promise<Result<boolean>> {
    const result = await this.store.delete(id);
    if (result.ok && result.value) logger.info('session deleted', { id });
    return result;
  }

  // ── Prune ──────────────────────────────────────────────────────────────────

  /**
   * Delete sessions whose updatedAt is older than `maxAgeDays` days.
   * Returns the number of deleted sessions.
   */
  async prune(maxAgeDays: number): Promise<Result<number>> {
    const listResult = await this.list();
    if (!listResult.ok) return { ok: false, error: listResult.error };

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const session of listResult.value) {
      if (new Date(session.updatedAt).getTime() < cutoff) {
        const r = await this.delete(session.id);
        if (r.ok && r.value) deleted++;
      }
    }

    logger.info('sessions pruned', { deleted, maxAgeDays });
    return { ok: true, value: deleted };
  }
}
