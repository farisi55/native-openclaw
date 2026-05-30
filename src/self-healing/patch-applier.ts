import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';
import type { GeneratedFilePatch } from './healing-types';
import { SafetyPolicy } from './safety-policy';
import { SnapshotManager } from './snapshot-manager';

export class PatchApplier {
  private readonly policy: SafetyPolicy;

  constructor(
    private readonly rootDir: string,
    private readonly snapshot: SnapshotManager
  ) {
    this.policy = new SafetyPolicy(rootDir);
  }

  async read(filePath: string): Promise<string | null> {
    const absolute = this.policy.assertSafeFilePath(filePath);
    try {
      return await readFile(absolute, 'utf-8');
    } catch {
      return null;
    }
  }

  async applyPatch(patch: GeneratedFilePatch): Promise<string> {
    const absolute = this.policy.assertSafeFilePath(patch.path);
    await this.snapshot.snapshotFile(absolute);

    if (patch.action === 'delete') {
      await unlink(absolute).catch(() => undefined);
      return this.policy.relativePath(absolute);
    }

    if (patch.content === undefined) {
      throw new Error(`Patch content is required for ${patch.action}: ${patch.path}`);
    }

    await mkdir(dirname(absolute), { recursive: true });
    const tmp = `${absolute}.tmp-${Date.now()}`;
    await writeFile(tmp, patch.content, 'utf-8');
    await rename(tmp, absolute);
    return this.policy.relativePath(absolute);
  }

  async applyAll(patches: GeneratedFilePatch[]): Promise<string[]> {
    const changed: string[] = [];
    for (const patch of patches) {
      changed.push(await this.applyPatch(patch));
    }
    return [...new Set(changed)].sort();
  }

  getChangedFiles(): string[] {
    return this.snapshot.getChangedFiles();
  }

  get root(): string {
    return this.rootDir;
  }
}
