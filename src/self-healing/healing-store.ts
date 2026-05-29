import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { HealingRun, HealingRunType } from './healing-types';

interface StoreShape {
  runs: HealingRun[];
}

export class HealingStore {
  private readonly filePath: string;
  private readonly tmpPath: string;

  constructor(dataDir: string, type: HealingRunType) {
    this.filePath = join(dataDir, type === 'self-healing' ? 'self-healing-runs.json' : 'self-upgrade-runs.json');
    this.tmpPath = `${this.filePath}.tmp`;
  }

  async list(): Promise<HealingRun[]> {
    return (await this.load()).runs;
  }

  async get(id: string): Promise<HealingRun | null> {
    const store = await this.load();
    return store.runs.find((run) => run.id === id || run.id.startsWith(id)) ?? null;
  }

  async saveRun(run: HealingRun): Promise<void> {
    const store = await this.load();
    const index = store.runs.findIndex((item) => item.id === run.id);
    if (index >= 0) store.runs[index] = run;
    else store.runs.unshift(run);
    store.runs = store.runs.slice(0, 100);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    await rename(this.tmpPath, this.filePath);
  }

  get path(): string {
    return this.filePath;
  }

  private async load(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as StoreShape).runs)) {
        return { runs: [] };
      }
      return parsed as StoreShape;
    } catch {
      return { runs: [] };
    }
  }
}
