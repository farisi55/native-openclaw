/**
 * skills/loader.ts
 * Scan a directory for .md skill files, parse each one, and
 * return a sorted Skill[] ready for the registry.
 *
 * Directory convention:
 *   skills/
 *     my-skill.md
 *
 * Environment override: SKILLS_DIR (absolute path).
 */

import { readdir, readFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import { existsSync } from 'fs';
import { parseSkillFile } from './parser';
import type { SkillFrontmatter } from './parser';
import type { Result } from '../types/global';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:loader');

// ─── Public types ─────────────────────────────────────────────────────────────

export interface Skill {
  /** Slug derived from the filename, e.g. "code-review". */
  id: string;
  name: string;
  description: string;
  filePath: string;
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface LoadSkillsOptions {
  /** Directory to scan (default: `<cwd>/skills`). */
  skillsDir?: string;
  /** Skip skills with `enabled: false` (default: true). */
  skipDisabled?: boolean;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function fileToId(fileName: string): string {
  return basename(fileName, '.md')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '');
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
      files.push(fullPath);
    }
  }
  return files;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Load all .md skill files from `skillsDir`.
 * Returns skills sorted by priority descending.
 */
export async function loadSkills(options: LoadSkillsOptions = {}): Promise<Result<Skill[]>> {
  const {
    skillsDir = process.env['SKILLS_DIR'] ?? join(process.cwd(), 'skills'),
    skipDisabled = true,
  } = options;

  if (!existsSync(skillsDir)) {
    logger.debug('skills directory not found — skipping', { skillsDir });
    return { ok: true, value: [] };
  }

  let mdFiles: string[];
  try {
    mdFiles = await listMarkdownFiles(skillsDir);
  } catch (cause) {
    return {
      ok: false,
      error: new Error(`Cannot read skills directory "${skillsDir}": ${String(cause)}`),
    };
  }

  if (mdFiles.length === 0) {
    logger.debug('no .md skill files found', { skillsDir });
    return { ok: true, value: [] };
  }

  const skills: Skill[] = [];
  const errors: string[] = [];

  for (const fileName of mdFiles) {
    const filePath = fileName;
    const displayName = basename(filePath);
    let source: string;

    try {
      source = await readFile(filePath, 'utf-8');
    } catch (cause) {
      errors.push(`Cannot read "${displayName}": ${String(cause)}`);
      continue;
    }

    const parsed = parseSkillFile(source, displayName);
    if (!parsed.ok) {
      errors.push(parsed.error.message);
      continue;
    }

    const { frontmatter, body } = parsed.value;
    if (skipDisabled && !frontmatter.enabled) {
      logger.debug('skill disabled — skipped', { fileName });
      continue;
    }

    skills.push({
      id: fileToId(fileName),
      name: frontmatter.name,
      description: frontmatter.description,
      filePath,
      frontmatter,
      body,
    });
  }

  if (errors.length > 0) logger.warn('some skill files had errors', { errors });

  // Higher priority first.
  skills.sort((a, b) => b.frontmatter.priority - a.frontmatter.priority);

  logger.info('skills loaded', {
    count: skills.length,
    skillsDir,
    ids: skills.map((s) => s.id),
  });

  return { ok: true, value: skills };
}

/**
 * Load a single skill file by absolute path.
 */
export async function loadSkillFromFile(filePath: string): Promise<Result<Skill>> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch (cause) {
    return { ok: false, error: new Error(`Cannot read "${filePath}": ${String(cause)}`) };
  }

  const fileName = basename(filePath);
  const parsed = parseSkillFile(source, fileName);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const { frontmatter, body } = parsed.value;
  return {
    ok: true,
    value: {
      id: fileToId(fileName),
      name: frontmatter.name,
      description: frontmatter.description,
      filePath,
      frontmatter,
      body,
    },
  };
}
