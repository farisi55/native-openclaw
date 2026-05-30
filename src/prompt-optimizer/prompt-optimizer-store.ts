import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { PromptOptimizationRunSummary } from './prompt-optimizer-types';

export class PromptOptimizerStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'prompt-optimizer-runs.json');
  }

  async append(summary: PromptOptimizationRunSummary): Promise<void> {
    const existing = await this.readAll();
    const next = [...existing, summary].slice(-200);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
    await rename(tmp, this.filePath);
  }

  async readAll(): Promise<PromptOptimizationRunSummary[]> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is PromptOptimizationRunSummary =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { timestamp?: unknown }).timestamp === 'string'
      );
    } catch {
      return [];
    }
  }

  async last(): Promise<PromptOptimizationRunSummary | null> {
    const all = await this.readAll();
    return all[all.length - 1] ?? null;
  }
}
