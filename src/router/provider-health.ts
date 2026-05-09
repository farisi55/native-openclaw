/**
 * router/provider-health.ts
 * Lightweight in-memory health + performance tracker for all providers.
 * Persists metrics to data/provider-health.json on each update.
 */

import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createLogger } from '../utils/logger';

const logger = createLogger('router:health');

export interface ProviderMetrics {
  providerId: string;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  lastLatencyMs: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  /** Tokens per second (moving average over last 10 calls) */
  avgTokensPerSec: number;
  recentLatencies: number[];   // last 10
}

const COOL_DOWN_MS = 30_000; // 30s before retrying a failed provider
const MAX_CONSECUTIVE_FAILURES = 3;

export class ProviderHealthTracker {
  private readonly metrics = new Map<string, ProviderMetrics>();
  private readonly filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'provider-health.json');
  }

  async load(): Promise<void> {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ProviderMetrics>;
      for (const [id, m] of Object.entries(data)) {
        this.metrics.set(id, m);
      }
      logger.debug('provider health loaded', { providers: [...this.metrics.keys()] });
    } catch {
      logger.debug('provider health file not readable — starting fresh');
    }
  }

  private ensureMetrics(providerId: string): ProviderMetrics {
    if (!this.metrics.has(providerId)) {
      this.metrics.set(providerId, {
        providerId,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        lastLatencyMs: 0,
        lastFailureAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        avgTokensPerSec: 0,
        recentLatencies: [],
      });
    }
    return this.metrics.get(providerId)!;
  }

  recordSuccess(providerId: string, latencyMs: number, tokensGenerated = 0): void {
    const m = this.ensureMetrics(providerId);
    m.successCount++;
    m.totalLatencyMs += latencyMs;
    m.lastLatencyMs = latencyMs;
    m.lastSuccessAt = Date.now();
    m.consecutiveFailures = 0;
    m.recentLatencies = [...m.recentLatencies.slice(-9), latencyMs];
    if (tokensGenerated > 0 && latencyMs > 0) {
      const tps = (tokensGenerated / latencyMs) * 1000;
      m.avgTokensPerSec = m.avgTokensPerSec === 0 ? tps : (m.avgTokensPerSec * 0.8 + tps * 0.2);
    }
    this.scheduleSave();
  }

  recordFailure(providerId: string): void {
    const m = this.ensureMetrics(providerId);
    m.failureCount++;
    m.lastFailureAt = Date.now();
    m.consecutiveFailures++;
    this.scheduleSave();
    logger.warn('provider failure recorded', { providerId, consecutiveFailures: m.consecutiveFailures });
  }

  isHealthy(providerId: string): boolean {
    const m = this.metrics.get(providerId);
    if (!m) return true; // no data = assume healthy
    if (m.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const elapsed = Date.now() - (m.lastFailureAt ?? 0);
      if (elapsed < COOL_DOWN_MS) return false;
      // Cool-down elapsed — reset and allow retry
      m.consecutiveFailures = 0;
    }
    return true;
  }

  getMetrics(providerId: string): ProviderMetrics | null {
    return this.metrics.get(providerId) ?? null;
  }

  allMetrics(): ProviderMetrics[] {
    return [...this.metrics.values()];
  }

  avgLatency(providerId: string): number {
    const m = this.metrics.get(providerId);
    if (!m || m.recentLatencies.length === 0) return Infinity;
    return m.recentLatencies.reduce((a, b) => a + b, 0) / m.recentLatencies.length;
  }

  successRate(providerId: string): number {
    const m = this.metrics.get(providerId);
    if (!m) return 1;
    const total = m.successCount + m.failureCount;
    return total === 0 ? 1 : m.successCount / total;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      await this.persist();
    }, 2000);
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.filePath, '..'), { recursive: true });
      const data = Object.fromEntries(this.metrics);
      await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      logger.debug('health persist failed', { error: String(e) });
    }
  }
}
