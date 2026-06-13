import { isAbsolute, relative, resolve, sep } from 'path';
import type { AgentExecutionResult, AgentTask } from './agent-gateway.types';

const DEFAULT_ALLOWED_PATHS = ['src/', 'test/', 'tests/', 'docs/', 'README.md'];
const DEFAULT_FORBIDDEN_PATHS = [
  '.env',
  '.env.',
  'node_modules/',
  'dist/',
  '.git/',
  '/etc/',
  '/root/',
];

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesPath(path: string, rule: string): boolean {
  const normalizedRule = normalizedPath(rule);
  if (normalizedRule.endsWith('/')) return path.startsWith(normalizedRule);
  if (normalizedRule.endsWith('*')) return path.startsWith(normalizedRule.slice(0, -1));
  if (normalizedRule === '.env.') return path.startsWith('.env.');
  return path === normalizedRule;
}

export class AgentGatewayPolicy {
  assertTask(task: AgentTask): void {
    if (!task.id.trim()) throw new Error('Agent task id is required.');
    if (!task.userInput.trim()) throw new Error('Agent task user input is required.');
    if (task.constraints?.requireApproval) {
      throw new Error('Agent task requires approval before delegation.');
    }
    if (task.cwd) {
      const root = resolve(task.cwd);
      if (!isAbsolute(root)) throw new Error('Agent task cwd must resolve to an absolute path.');
    }
  }

  validateResult(task: AgentTask, result: AgentExecutionResult): string[] {
    if (task.capability !== 'coding.patch' || !result.changedFiles) return [];
    const allowed = task.constraints?.allowedPaths?.map(normalizedPath) ?? DEFAULT_ALLOWED_PATHS;
    const forbidden = [
      ...DEFAULT_FORBIDDEN_PATHS,
      ...(task.constraints?.forbiddenPaths?.map(normalizedPath) ?? []),
    ];
    const violations: string[] = [];

    for (const rawPath of result.changedFiles) {
      const path = normalizedPath(rawPath);
      if (forbidden.some((rule) => matchesPath(path, rule))) {
        violations.push(`${path}: forbidden path`);
        continue;
      }
      if (
        (path === 'package.json' || path === 'package-lock.json') &&
        !task.constraints?.allowPackageJsonChanges
      ) {
        violations.push(`${path}: dependency manifest changes are not allowed`);
        continue;
      }
      if (!allowed.some((rule) => matchesPath(path, rule))) {
        violations.push(`${path}: outside allowed paths`);
      }
    }
    return violations;
  }

  resolveTaskPath(task: AgentTask, filePath: string): string {
    const root = resolve(task.cwd ?? process.cwd());
    const absolute = resolve(root, filePath);
    const rel = relative(root, absolute);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Agent path escapes the task cwd: ${filePath}`);
    }
    return rel.split(sep).join('/');
  }
}
