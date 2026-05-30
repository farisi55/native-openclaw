import { copyFile, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { SafetyPolicy } from './safety-policy';

interface SnapshotEntry {
  path: string;
  snapshotPath: string;
  existed: boolean;
}

export interface FileSnapshotRecord {
  existed: boolean;
  content: string | null;
}

export class SnapshotManager {
  private readonly policy: SafetyPolicy;
  private readonly entries = new Map<string, SnapshotEntry>();

  constructor(
    rootDir: string,
    private readonly snapshotDir: string
  ) {
    this.policy = new SafetyPolicy(rootDir);
  }

  async snapshotFile(filePath: string): Promise<void> {
    const absolute = this.policy.assertSafeFilePath(filePath);
    const rel = this.policy.relativePath(absolute);
    if (this.entries.has(rel)) return;

    const snapshotPath = join(this.snapshotDir, 'files', rel);
    await mkdir(dirname(snapshotPath), { recursive: true });

    try {
      await copyFile(absolute, snapshotPath);
      this.entries.set(rel, { path: absolute, snapshotPath, existed: true });
    } catch {
      this.entries.set(rel, { path: absolute, snapshotPath, existed: false });
    }

    await this.writeManifest();
  }

  async rollback(): Promise<void> {
    for (const entry of [...this.entries.values()].reverse()) {
      if (entry.existed) {
        await mkdir(dirname(entry.path), { recursive: true });
        await copyFile(entry.snapshotPath, entry.path);
      } else {
        await unlink(entry.path).catch(() => undefined);
      }
    }
  }

  changedFiles(): string[] {
    return [...this.entries.keys()].sort();
  }

  getChangedFiles(): string[] {
    return this.changedFiles();
  }

  private async writeManifest(): Promise<void> {
    await mkdir(this.snapshotDir, { recursive: true });
    const manifest = [...this.entries.values()].map((entry) => ({
      path: this.policy.relativePath(entry.path),
      snapshotPath: entry.snapshotPath,
      existed: entry.existed,
    }));
    await writeFile(join(this.snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  async readOriginal(filePath: string): Promise<string | null> {
    const absolute = this.policy.assertSafeFilePath(filePath);
    const rel = this.policy.relativePath(absolute);
    const entry = this.entries.get(rel);
    if (!entry || !entry.existed) return null;
    return readFile(entry.snapshotPath, 'utf-8');
  }

  async getOriginalContent(filePath: string): Promise<string | null> {
    return this.readOriginal(filePath);
  }

  async getFileSnapshotMap(): Promise<Map<string, FileSnapshotRecord>> {
    const records = new Map<string, FileSnapshotRecord>();
    for (const [rel, entry] of this.entries.entries()) {
      records.set(rel, {
        existed: entry.existed,
        content: entry.existed ? await readFile(entry.snapshotPath, 'utf-8') : null,
      });
    }
    return records;
  }
}
