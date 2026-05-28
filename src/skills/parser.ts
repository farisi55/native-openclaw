/**
 * skills/parser.ts
 * Parse .md skill files with YAML frontmatter.
 *
 * Supported frontmatter primitives: string, number, boolean,
 * null, and inline arrays  ("[a, b, c]" or "a, b, c").
 * No external YAML library required.
 */

import type { Result } from '../types/global';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SkillFrontmatter {
  /** Display name — defaults to filename stem. */
  name: string;
  /** Short description injected into the system prompt header. */
  description: string;
  /** Semver string (default: "1.0.0"). */
  version: string;
  /** Arbitrary tags for filtering. */
  tags: string[];
  /**
   * Injection priority — higher values appear first.
   * Default: 0.
   */
  priority: number;
  /** Whether the skill is active. Default: true. */
  enabled: boolean;
  auto_generated?: boolean;
  created_at?: string;
  usage_count?: number;
  success_rate?: number;
  /** Raw key→string pairs from the frontmatter block. */
  raw: Record<string, string>;
}

export interface ParsedSkillFile {
  frontmatter: SkillFrontmatter;
  /** Markdown body after the frontmatter block is stripped. */
  body: string;
}

// ─── Scalar parser ────────────────────────────────────────────────────────────

function parseScalar(value: string): string | number | boolean | null {
  const t = value.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~' || t === '') return null;
  const num = Number(t);
  if (!isNaN(num)) return num;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineArray(raw: string): string[] {
  const inner = raw.trim().slice(1, -1);
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((s) => {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    })
    .filter(Boolean);
}

function parseYamlLines(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

// ─── Frontmatter builder ──────────────────────────────────────────────────────

function buildFrontmatter(raw: Record<string, string>, fileStem: string): SkillFrontmatter {
  const name = (raw['name'] ?? fileStem).trim();
  const description = (raw['description'] ?? '').trim();
  const version = (raw['version'] ?? '1.0.0').trim();

  let tags: string[] = [];
  if (raw['tags']) {
    const t = raw['tags'].trim();
    tags = t.startsWith('[') ? parseInlineArray(t) : t.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const priorityRaw = raw['priority'];
  const priority = priorityRaw !== undefined ? Number(priorityRaw) : 0;

  const enabledRaw = raw['enabled'];
  const enabled = enabledRaw !== undefined ? parseScalar(enabledRaw) !== false : true;
  const usageCount = raw['usage_count'] !== undefined ? Number(raw['usage_count']) : undefined;
  const successRate = raw['success_rate'] !== undefined ? Number(raw['success_rate']) : undefined;

  const frontmatter: SkillFrontmatter = {
    name,
    description,
    version,
    tags,
    priority: isNaN(priority) ? 0 : priority,
    enabled: Boolean(enabled),
    raw,
  };
  if (raw['auto_generated'] !== undefined) frontmatter.auto_generated = parseScalar(raw['auto_generated']) === true;
  if (raw['created_at']) frontmatter.created_at = raw['created_at'];
  if (usageCount !== undefined && !isNaN(usageCount)) frontmatter.usage_count = usageCount;
  if (successRate !== undefined && !isNaN(successRate)) frontmatter.success_rate = successRate;
  return frontmatter;
}

// ─── Main parser ──────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

/**
 * Parse a raw skill markdown file.
 *
 * @param source   - Raw file content.
 * @param fileName - Filename used as fallback for `name`.
 */
export function parseSkillFile(source: string, fileName: string): Result<ParsedSkillFile> {
  try {
    const fileStem = fileName.replace(/\.md$/i, '');
    const match = FRONTMATTER_RE.exec(source.trimStart());

    if (!match) {
      return {
        ok: true,
        value: {
          frontmatter: buildFrontmatter({}, fileStem),
          body: source.trim(),
        },
      };
    }

    const [, yamlBlock, body] = match as unknown as [string, string, string];
    const raw = parseYamlLines(yamlBlock.split('\n').filter((l) => l.trim()));

    return {
      ok: true,
      value: {
        frontmatter: buildFrontmatter(raw, fileStem),
        body: body.trim(),
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: new Error(`Failed to parse skill file "${fileName}": ${String(cause)}`),
    };
  }
}
