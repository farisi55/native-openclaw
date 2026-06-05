import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname, isAbsolute, parse, resolve } from 'path';
import { homedir } from 'os';

export interface ResolveOpenCodeCwdInput {
  explicitCwd?: string;
  envCwd?: string;
  startDir?: string;
}

export interface ResolveOpenCodeCwdResult {
  cwd: string;
  source: 'input' | 'env' | 'auto-detected' | 'process.cwd';
  valid: boolean;
  reason: string;
}

const PROJECT_PACKAGE_NAMES = new Set(['native-openclaw', 'smooth']);

function cleanInput(value?: string): string | undefined {
  const trimmed = String(value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolvePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

function isFilesystemRoot(dir: string): boolean {
  const parsed = parse(resolve(dir));
  return resolve(dir) === resolve(parsed.root);
}

function safeStatDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function hasPath(dir: string, name: string): boolean {
  return existsSync(resolve(dir, name));
}

function packageJsonInfo(dir: string): { exists: boolean; name?: string; hasBuildScript: boolean } {
  const file = resolve(dir, 'package.json');
  if (!existsSync(file)) return { exists: false, hasBuildScript: false };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
    return {
      exists: true,
      ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
      hasBuildScript: typeof parsed.scripts?.['build'] === 'string',
    };
  } catch {
    return { exists: true, hasBuildScript: false };
  }
}

function projectScore(dir: string): { score: number; strong: boolean; packageNameMatches: boolean } {
  const pkg = packageJsonInfo(dir);
  const hasTsconfig = hasPath(dir, 'tsconfig.json');
  const hasSrc = hasPath(dir, 'src');
  const hasDist = hasPath(dir, 'dist');
  const hasWorkspace = hasPath(dir, 'workspace');
  const hasSkills = hasPath(dir, 'skills');

  let score = 0;
  if (pkg.exists) score += 3;
  if (hasTsconfig) score += 2;
  if (hasSrc) score += 2;
  if (hasDist) score += 1;
  if (hasWorkspace) score += 1;
  if (hasSkills) score += 1;
  if (pkg.hasBuildScript) score += 1;

  return {
    score,
    strong: pkg.exists && (hasTsconfig || hasSrc || hasDist),
    packageNameMatches: typeof pkg.name === 'string' && PROJECT_PACKAGE_NAMES.has(pkg.name),
  };
}

function isProjectRoot(dir: string): boolean {
  const score = projectScore(dir);
  return score.strong && score.score >= 4;
}

export function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  if (!safeStatDirectory(current)) current = dirname(current);

  while (true) {
    const marker = projectScore(current);
    if (marker.packageNameMatches && marker.strong) return current;
    if (marker.strong && marker.score >= 4) return current;

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function validateCandidate(dir: string, allowHomeProjectRoot: boolean): string | null {
  const cwd = resolve(dir);
  if (!safeStatDirectory(cwd)) return 'cwd does not exist or is not a directory';
  if (isFilesystemRoot(cwd)) return 'cwd points to filesystem root';
  if (basename(cwd).toLowerCase() === 'node_modules') return 'cwd points to node_modules';

  const home = resolve(homedir());
  if (cwd === home && !(allowHomeProjectRoot && isProjectRoot(cwd))) {
    return 'cwd points to user home, not a detected project root';
  }

  if (basename(cwd).toLowerCase() === 'dist') {
    const parent = dirname(cwd);
    if (isProjectRoot(parent)) return 'cwd points to dist; parent project root should be used';
  }

  return null;
}

function resolveConfiguredCwd(
  value: string,
  source: 'input' | 'env',
  baseDir: string
): ResolveOpenCodeCwdResult | null {
  const cwd = resolvePath(value, baseDir);
  const invalidReason = validateCandidate(cwd, false);
  if (invalidReason) {
    const autoRoot = findProjectRoot(cwd);
    if (autoRoot) {
      return {
        cwd: autoRoot,
        source: 'auto-detected',
        valid: true,
        reason: `${source} cwd was invalid (${invalidReason}); auto-detected project root.`,
      };
    }
    return null;
  }

  return {
    cwd,
    source,
    valid: true,
    reason: `${source} cwd is valid.`,
  };
}

export function resolveOpenCodeCwd(input: ResolveOpenCodeCwdInput = {}): ResolveOpenCodeCwdResult {
  const startDir = resolve(input.startDir ?? process.cwd());
  const explicitCwd = cleanInput(input.explicitCwd);
  const envCwd = cleanInput(input.envCwd);

  if (explicitCwd) {
    const explicit = resolveConfiguredCwd(explicitCwd, 'input', startDir);
    if (explicit) return explicit;
  }

  if (envCwd) {
    const env = resolveConfiguredCwd(envCwd, 'env', startDir);
    if (env) return env;
  }

  const autoRoot = findProjectRoot(startDir);
  if (autoRoot) {
    return {
      cwd: autoRoot,
      source: 'auto-detected',
      valid: true,
      reason: 'Auto-detected project root from package/TypeScript/source markers.',
    };
  }

  const fallback = startDir;
  const invalidReason = validateCandidate(fallback, true);
  return {
    cwd: fallback,
    source: 'process.cwd',
    valid: !invalidReason,
    reason: invalidReason
      ? `Fell back to process.cwd but it is invalid: ${invalidReason}.`
      : 'Fell back to process.cwd because no project root markers were found.',
  };
}
