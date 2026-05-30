import { getEnvInt } from '../config/env';
import type { FileChangeType, FileDiffSummary } from './healing-types';
import { redactSecrets } from './log-redactor';

export interface DiffGeneratorOptions {
  maxDiffChars?: number;
  contextLines?: number;
  redactSecrets?: boolean;
}

interface DiffInput {
  path: string;
  beforeContent: string | null;
  afterContent: string | null;
  maxDiffChars?: number;
}

interface LineChange {
  kind: 'same' | 'add' | 'del';
  line: string;
}

export class DiffGenerator {
  private readonly maxDiffChars: number;
  private readonly redact: boolean;

  constructor(options: DiffGeneratorOptions = {}) {
    this.maxDiffChars = options.maxDiffChars ?? getEnvInt('SELF_HEALING_MAX_DIFF_CHARS', 20_000);
    this.redact = options.redactSecrets ?? true;
  }

  generateFileDiff(input: DiffInput): FileDiffSummary {
    const changeType = classifyChange(input.beforeContent, input.afterContent);
    const beforeSize = input.beforeContent?.length ?? 0;
    const afterSize = input.afterContent?.length ?? 0;
    const maxDiffChars = input.maxDiffChars ?? this.maxDiffChars;

    if (isProtectedPath(input.path)) {
      return {
        path: input.path,
        changeType,
        additions: 0,
        deletions: 0,
        beforeSize,
        afterSize,
        diffText: 'Diff omitted for protected file.',
        truncated: false,
      };
    }

    const before = redactSecrets(input.beforeContent ?? '', this.redact);
    const after = redactSecrets(input.afterContent ?? '', this.redact);
    const changes = diffLines(splitLines(before), splitLines(after));
    const additions = changes.filter((change) => change.kind === 'add').length;
    const deletions = changes.filter((change) => change.kind === 'del').length;
    const header = headerFor(input.path, changeType);
    const body = changes.map((change) => {
      if (change.kind === 'add') return `+${change.line}`;
      if (change.kind === 'del') return `-${change.line}`;
      return ` ${change.line}`;
    });

    const fullDiff = [...header, '@@ summary', ...body].join('\n');
    const truncated = fullDiff.length > maxDiffChars;
    const diffText = truncated
      ? `${fullDiff.slice(0, Math.max(0, maxDiffChars - 34))}\n...[diff truncated]`
      : fullDiff;

    return {
      path: input.path,
      changeType,
      additions,
      deletions,
      beforeSize,
      afterSize,
      diffText,
      truncated,
    };
  }

  generateDiffs(inputs: DiffInput[]): FileDiffSummary[] {
    return inputs
      .map((input) => this.generateFileDiff(input))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

function classifyChange(beforeContent: string | null, afterContent: string | null): FileChangeType {
  if (beforeContent === null && afterContent !== null) return 'created';
  if (beforeContent !== null && afterContent === null) return 'deleted';
  return 'updated';
}

function headerFor(path: string, changeType: FileChangeType): string[] {
  if (changeType === 'created') return ['--- /dev/null', `+++ b/${path}`];
  if (changeType === 'deleted') return [`--- a/${path}`, '+++ /dev/null'];
  return [`--- a/${path}`, `+++ b/${path}`];
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffLines(before: string[], after: string[]): LineChange[] {
  const lengths = new Array<number[]>((before.length + 1));
  for (let i = 0; i <= before.length; i += 1) {
    lengths[i] = new Array<number>(after.length + 1).fill(0);
  }

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = before[i] === after[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      changes.push({ kind: 'same', line: before[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      changes.push({ kind: 'del', line: before[i]! });
      i += 1;
    } else {
      changes.push({ kind: 'add', line: after[j]! });
      j += 1;
    }
  }

  while (i < before.length) {
    changes.push({ kind: 'del', line: before[i]! });
    i += 1;
  }
  while (j < after.length) {
    changes.push({ kind: 'add', line: after[j]! });
    j += 1;
  }
  return changes;
}

function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts[parts.length - 1] ?? '';
  return parts.includes('.git') ||
    parts.includes('node_modules') ||
    parts.includes('dist') ||
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.pem') ||
    basename.endsWith('.key') ||
    basename === 'id_rsa' ||
    basename.startsWith('secrets.');
}
