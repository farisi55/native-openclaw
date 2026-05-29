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

export interface SkillUsageRef {
  id: string;
  name: string;
  filePath: string;
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

  get qualityFilePath(): string {
    return this.filePath;
  }

  get threshold(): number {
    return this.evaluationThreshold;
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

  private applySkillUsage(skill: SkillUsageRef, success: boolean): void {
    const now = new Date().toISOString();
    const existing = this.store.skills[skill.id];
    const entry: SkillQualityEntry = existing ?? {
      name: skill.name,
      filePath: skill.filePath,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      lastUsed: now,
      createdAt: now,
    };

    entry.name = skill.name;
    entry.filePath = skill.filePath;
    entry.usageCount += 1;
    if (success) entry.successCount += 1;
    else entry.failureCount += 1;
    entry.lastUsed = now;
    this.store.skills[skill.id] = entry;
  }

  async recordTaskCompletion(
    skillsUsedOrId: SkillUsageRef[] | string | null = [],
    success: boolean
  ): Promise<void> {
    await this.load();
    this.store.taskCounter += 1;

    const skillsUsed = Array.isArray(skillsUsedOrId)
      ? skillsUsedOrId
      : skillsUsedOrId
        ? [{ id: skillsUsedOrId, name: skillsUsedOrId, filePath: skillsUsedOrId }]
        : [];

    const seen = new Set<string>();
    for (const skill of skillsUsed) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      this.applySkillUsage(skill, success);
    }

    await this.save();
    logger.debug('skill quality task recorded', {
      skillsUsed: [...seen],
      success,
      taskCounter: this.store.taskCounter,
    });
  }

  async recordSkillUsage(skillId: string, skillName: string, filePath: string, success: boolean): Promise<void> {
    await this.load();
    this.applySkillUsage({ id: skillId, name: skillName, filePath }, success);
    await this.save();
    logger.debug('skill usage recorded', { skillId, success });
  }

  async registerSkill(id: string, name: string, filePath: string): Promise<void> {
    await this.load();
    if (!this.store.skills[id]) {
      const now = new Date().toISOString();
      this.store.skills[id] = {
        name,
        filePath,
        usageCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsed: now,
        createdAt: now,
      };
      await this.save();
    }
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
