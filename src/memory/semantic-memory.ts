/**
 * memory/semantic-memory.ts
 * Lightweight semantic memory using TF-IDF-style keyword scoring.
 *
 * NO external vector DB. NO embeddings API.
 * Uses local JSON storage with cosine-like similarity on keyword overlap.
 *
 * Design:
 * - Each memory chunk = a conversation exchange + keywords + timestamp
 * - Retrieval = keyword overlap + recency weighting
 * - Storage = local JSON file (SQLite-ready abstraction)
 */

import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';

const logger = createLogger('memory:semantic');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryChunk {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** Extracted keywords for similarity search. */
  keywords: string[];
  /** Unix timestamp ms. */
  createdAt: number;
  /** Importance score (boosted by fact extraction, mentions, etc). */
  importance: number;
}

export interface RetrievedMemory {
  chunk: MemoryChunk;
  score: number;
}

// ─── Keyword extractor ────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could',
  'should','may','might','shall','can','need','dare','ought',
  'to','of','in','on','at','by','for','with','as','from',
  'and','or','but','not','so','yet','both','either',
  'i','me','my','you','your','we','our','he','she','it',
  'they','them','this','that','what','which','who','whom',
  'how','when','where','why','if','then','than','there',
]);

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 30); // max 30 keywords per chunk
}

function cosineSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const denom = Math.sqrt(setA.size * setB.size);
  return denom === 0 ? 0 : intersection / denom;
}

// ─── SemanticMemory ───────────────────────────────────────────────────────────

const MAX_CHUNKS = 2000;       // Max stored chunks before oldest are pruned
const CHUNK_TTL_DAYS = 30;     // Chunks older than this are pruned on load

export class SemanticMemory {
  private chunks: MemoryChunk[] = [];
  private readonly filePath: string;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'semantic-memory.json');
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) {
      logger.debug('semantic memory file not found — starting empty');
      return;
    }
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as { chunks: MemoryChunk[] };
      const cutoff = Date.now() - CHUNK_TTL_DAYS * 86_400_000;
      this.chunks = (data.chunks ?? []).filter((c) => c.createdAt > cutoff);
      logger.debug('semantic memory loaded', { chunks: this.chunks.length });
    } catch (e) {
      logger.debug('semantic memory parse error — starting empty', { error: String(e) });
    }
  }

  // ── Store ──────────────────────────────────────────────────────────────────

  store(sessionId: string, role: 'user' | 'assistant', content: string, importance = 1): MemoryChunk {
    const chunk: MemoryChunk = {
      id: randomUUID().slice(0, 8),
      sessionId,
      role,
      content: content.slice(0, 2000), // cap individual chunk size
      keywords: extractKeywords(content),
      createdAt: Date.now(),
      importance,
    };
    this.chunks.push(chunk);
    if (this.chunks.length > MAX_CHUNKS) {
      // Prune oldest low-importance chunks
      this.chunks = this.chunks
        .sort((a, b) => (b.importance * b.createdAt) - (a.importance * a.createdAt))
        .slice(0, MAX_CHUNKS);
    }
    this.scheduleSave();
    return chunk;
  }

  // ── Retrieve ───────────────────────────────────────────────────────────────

  /**
   * Retrieve the most relevant memories for a given query.
   *
   * @param query       - The current user input or topic.
   * @param topK        - Max chunks to return.
   * @param sessionId   - Boost chunks from the same session.
   * @param maxAgeDays  - Ignore chunks older than this.
   */
  retrieve(
    query: string,
    topK = 5,
    sessionId?: string,
    maxAgeDays = 7
  ): RetrievedMemory[] {
    const queryKeywords = extractKeywords(query);
    if (queryKeywords.length === 0) return [];

    const cutoff = Date.now() - maxAgeDays * 86_400_000;

    const scored = this.chunks
      .filter((c) => c.createdAt > cutoff)
      .map((chunk): RetrievedMemory => {
        let score = cosineSimilarity(queryKeywords, chunk.keywords);
        // Recency boost: last hour → +0.3, last day → +0.1
        const ageMs = Date.now() - chunk.createdAt;
        if (ageMs < 3_600_000) score += 0.3;
        else if (ageMs < 86_400_000) score += 0.1;
        // Same-session boost
        if (sessionId && chunk.sessionId === sessionId) score += 0.2;
        // Importance boost
        score *= (1 + (chunk.importance - 1) * 0.1);
        return { chunk, score };
      })
      .filter((r) => r.score > 0.05) // minimum relevance threshold
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    logger.debug('semantic memory retrieval', {
      query: query.slice(0, 50),
      results: scored.length,
    });

    return scored;
  }

  // ── Summarise session ──────────────────────────────────────────────────────

  getSessionChunks(sessionId: string, limit = 20): MemoryChunk[] {
    return this.chunks
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .reverse();
  }

  size(): number {
    return this.chunks.length;
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.save();
    }, 3000);
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      await writeFile(this.filePath, JSON.stringify({ chunks: this.chunks }, null, 2), 'utf-8');
      this.dirty = false;
    } catch (e) {
      logger.debug('semantic memory save failed', { error: String(e) });
    }
  }
}
