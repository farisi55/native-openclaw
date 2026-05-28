/**
 * skills/skill-writer.ts
 * Writes extracted skills to disk as markdown files.
 */

import { randomUUID } from 'crypto';
import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import type { ExtractedSkill } from './skill-extractor';
import { parseSkillFile } from './parser';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:writer');

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'skill';
}

function frontmatterValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

function tagsValue(tags: string[]): string {
  return `[${tags.map((tag) => frontmatterValue(tag)).filter(Boolean).join(', ')}]`;
}

export class SkillWriter {
  constructor(private readonly skillsDir = 'skills/auto-generated') {}

  async listAutoSkills(): Promise<string[]> {
    try {
      const entries = await readdir(this.skillsDir);
      return entries
        .filter((entry) => entry.toLowerCase().endsWith('.md'))
        .map((entry) => join(this.skillsDir, entry));
    } catch {
      return [];
    }
  }

  private async hasDuplicateName(skillName: string): Promise<boolean> {
    const lowerName = skillName.trim().toLowerCase();
    for (const filePath of await this.listAutoSkills()) {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed = parseSkillFile(raw, basename(filePath));
        if (parsed.ok && parsed.value.frontmatter.name.trim().toLowerCase() === lowerName) return true;
      } catch (err) {
        logger.debug('skill duplicate check skipped unreadable file', {
          filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return false;
  }

  async write(skill: ExtractedSkill): Promise<string | null> {
    await mkdir(this.skillsDir, { recursive: true });
    if (await this.hasDuplicateName(skill.name)) {
      logger.info('auto-generated skill skipped as duplicate', { name: skill.name });
      return null;
    }

    const fileName = `auto-${slugify(skill.name)}-${randomUUID().replace(/-/g, '').slice(0, 8)}.md`;
    const filePath = join(this.skillsDir, fileName);
    const content = [
      '---',
      `name: ${frontmatterValue(skill.name)}`,
      `description: ${frontmatterValue(skill.description)}`,
      'version: 1.0.0',
      `tags: ${tagsValue(skill.tags)}`,
      'priority: 5',
      'enabled: true',
      'auto_generated: true',
      `created_at: ${new Date().toISOString()}`,
      'usage_count: 0',
      'success_rate: 1.0',
      '---',
      '',
      skill.body.trim(),
      '',
    ].join('\n');

    await writeFile(filePath, content, 'utf-8');
    logger.info('auto-generated skill written', { name: skill.name, filePath });
    return filePath;
  }
}
