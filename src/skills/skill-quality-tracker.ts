/**
 * skills/skill-quality-tracker.ts
 * Tracks usage count, success rate, and task counter per skill.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:quality');

export interface SkillQualityEntry {
  name: string;
  filePath: string;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: string;
  createdAt: string;
}

interface SkillQualityStore {
  taskCounter: number;
  skills: Record<string, SkillQualityEntry>;
}

const EMPTY_STORE: SkillQualityStore = { taskCounter: 0, skills: {} };

async function atomicWrite(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, data, 'utf-8');
  await rename(tmp, filePath);
}

function normalizeStore(value: unknown): SkillQualityStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_STORE, skills: {} };
  const raw = value as Partial<SkillQualityStore>;
  return {
    taskCounter: typeof raw.taskCounter === 'number' ? raw.taskCounter : 0,
    skills: raw.skills && typeof raw.skills === 'object' ? raw.skills : {},
  };
}

export class SkillQualityTracker {
  private readonly filePath: string;
  private store: SkillQualityStore = { ...EMPTY_STORE, skills: {} };
  private loaded = false;

  constructor(dataDir = 'data', private readonly evaluationThreshold = 10) {
    this.filePath = join(dataDir, 'skill-quality.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      this.store = normalizeStore(JSON.parse(raw));
    } catch {
      this.store = { ...EMPTY_STORE, skills: {} };
      await this.save();
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await atomicWrite(this.filePath, JSON.stringify(this.store, null, 2));
  }

  async recordTaskCompletion(skillId: string | null, success: boolean): Promise<void> {
    await this.load();
    this.store.taskCounter += 1;
    if (skillId) {
      const now = new Date().toISOString();
      const existing = this.store.skills[skillId];
      const entry: SkillQualityEntry = existing ?? {
        name: skillId,
        filePath: skillId,
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsed: now,
        createdAt: now,
      };
      entry.usageCount += 1;
      if (success) entry.successCount += 1;
      else entry.failureCount += 1;
      entry.lastUsed = now;
      this.store.skills[skillId] = entry;
    }
    await this.save();
    logger.debug('skill quality task recorded', { skillId, success, taskCounter: this.store.taskCounter });
  }

  async shouldRunEvaluation(): Promise<boolean> {
    await this.load();
    const threshold = Math.max(1, this.evaluationThreshold);
    return this.store.taskCounter > 0 && this.store.taskCounter % threshold === 0;
  }

  async resetEvaluationCounter(): Promise<void> {
    await this.load();
    this.store.taskCounter = 0;
    await this.save();
  }

  getSkillStats(skillId: string): SkillQualityEntry | null {
    return this.store.skills[skillId] ?? null;
  }

  getAllStats(): SkillQualityEntry[] {
    return Object.values(this.store.skills);
  }

  getTaskCounter(): number {
    return this.store.taskCounter;
  }
}
