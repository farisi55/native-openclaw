import { readdir, readFile, stat } from 'fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { IProvider } from '../types/provider';
import { createMessage, extractText } from '../types/message';
import { createLogger } from '../utils/logger';
import type {
  BugAnalysis,
  GeneratedFilePatch,
  PatchPlan,
  QAReport,
  UpgradeAnalysis,
} from './healing-types';
import { PatchApplier } from './patch-applier';
import { redactSecrets } from './log-redactor';
import {
  isOpenCodeDirectModeEnabled,
  isOpenCodeEnvironmentFailure,
  runOpenCodeAgent,
} from '../tools/opencode-agent';

type CodingMode = 'self-healing' | 'self-upgrade';

interface RepoFileState {
  size: number;
  mtimeMs: number;
  content: string | null;
}

export interface OpenCodeFallbackState {
  attempted?: boolean;
  attempts?: number;
  fallbackUsed?: boolean;
  unavailable?: boolean;
  unavailableReason?: string;
  lastError?: string;
  lastErrorType?: string;
  lastOutput?: string;
  lastSuggestion?: string;
}

const selfHealingLogger = createLogger('self-healing');
const selfUpgradeLogger = createLogger('self-upgrade');
const OPEN_CODE_SCAN_MAX_FILES = 2500;
const OPEN_CODE_SCAN_MAX_BYTES = 500_000;
const OPEN_CODE_FALLBACK_OUTPUT_MAX_CHARS = 4000;
const TRACKED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
]);
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.data',
  '.turbo',
  'coverage',
  'data',
  'dist',
  'node_modules',
  'snapshot',
  'tmp',
  'workspace',
]);

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parsePatches(text: string): GeneratedFilePatch[] {
  const parsed = JSON.parse(stripJsonFences(text)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const files = (parsed as Record<string, unknown>)['files'];
  if (!Array.isArray(files)) return [];

  return files.flatMap((item): GeneratedFilePatch[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const path = typeof record['path'] === 'string' ? record['path'] : '';
    const action = record['action'];
    if (!path || (action !== 'create' && action !== 'update' && action !== 'delete')) return [];
    const content = typeof record['content'] === 'string' ? record['content'] : undefined;
    if (content !== undefined) return [{ path, action, content }];
    return [{ path, action }];
  });
}

function compactOpenCodeOutput(text: string, redact = true): string {
  const redacted = redactSecrets(text, redact).trim();
  if (redacted.length <= OPEN_CODE_FALLBACK_OUTPUT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, OPEN_CODE_FALLBACK_OUTPUT_MAX_CHARS)}\n...[OpenCode output truncated]`;
}

function tryParsePatches(text: string): GeneratedFilePatch[] {
  try {
    return parsePatches(text);
  } catch {
    return [];
  }
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function shouldUseOpenCode(mode: CodingMode): boolean {
  if (!envBool('OPENCODE_AGENT_ENABLED', false)) return false;
  if (mode === 'self-healing') return envBool('OPENCODE_AGENT_USE_FOR_SELF_HEALING', false);
  return envBool('OPENCODE_AGENT_USE_FOR_SELF_UPGRADE', false);
}

function loggerFor(mode: CodingMode): ReturnType<typeof createLogger> {
  return mode === 'self-healing' ? selfHealingLogger : selfUpgradeLogger;
}

function normalizedRel(rootDir: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(rootDir, filePath);
  return relative(rootDir, absolute).split(sep).join('/');
}

function isTrackedFile(filePath: string): boolean {
  const name = filePath.split(/[\\/]+/).pop() ?? '';
  if (name === '.env' || name.startsWith('.env.')) return false;
  if (name.endsWith('.pem') || name.endsWith('.key') || name.startsWith('secrets.')) return false;
  return TRACKED_EXTENSIONS.has(extname(name).toLowerCase());
}

async function collectRepoState(rootDir: string): Promise<Map<string, RepoFileState>> {
  const root = resolve(rootDir);
  const state = new Map<string, RepoFileState>();
  let scanned = 0;

  async function walk(dir: string): Promise<void> {
    if (scanned >= OPEN_CODE_SCAN_MAX_FILES) return;

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned >= OPEN_CODE_SCAN_MAX_FILES) return;
      const entryName = String(entry.name);
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entryName)) continue;

      const absolute = join(dir, entryName);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      if (!entry.isFile() || !isTrackedFile(absolute)) continue;

      try {
        const fileStat = await stat(absolute);
        scanned += 1;
        const content = fileStat.size <= OPEN_CODE_SCAN_MAX_BYTES
          ? await readFile(absolute, 'utf-8').catch(() => null)
          : null;
        state.set(normalizedRel(root, absolute), {
          size: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          content,
        });
      } catch {
        // Ignore files that disappear while scanning.
      }
    }
  }

  await walk(root);
  return state;
}

function fileStateChanged(before?: RepoFileState, after?: RepoFileState): boolean {
  if (!before || !after) return true;
  if (before.content !== null && after.content !== null) return before.content !== after.content;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

function changedFilesBetween(
  before: Map<string, RepoFileState>,
  after: Map<string, RepoFileState>
): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files]
    .filter((file) => fileStateChanged(before.get(file), after.get(file)))
    .sort();
}

export class CodingAgent {
  constructor(
    private readonly provider?: IProvider,
    private readonly model = 'default',
    private readonly temperature = 0.1,
    private readonly redact = true
  ) {}

  async applyBugFix(input: {
    userInput: string;
    analysis: BugAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    errorLog?: string;
    patchApplier: PatchApplier;
    runId?: string;
    loop?: number;
    openCodeState?: OpenCodeFallbackState;
  }): Promise<string[]> {
    return this.apply({
      mode: 'self-healing',
      userInput: input.userInput,
      analysis: input.analysis,
      patchPlan: input.patchPlan,
      ...(input.previousQa ? { previousQa: input.previousQa } : {}),
      ...(input.errorLog ? { errorLog: input.errorLog } : {}),
      patchApplier: input.patchApplier,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.loop ? { loop: input.loop } : {}),
      ...(input.openCodeState ? { openCodeState: input.openCodeState } : {}),
    });
  }

  async applyUpgrade(input: {
    userInput: string;
    analysis: UpgradeAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    patchApplier: PatchApplier;
    runId?: string;
    loop?: number;
    openCodeState?: OpenCodeFallbackState;
  }): Promise<string[]> {
    return this.apply({
      mode: 'self-upgrade',
      userInput: input.userInput,
      analysis: input.analysis,
      patchPlan: input.patchPlan,
      ...(input.previousQa ? { previousQa: input.previousQa } : {}),
      patchApplier: input.patchApplier,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.loop ? { loop: input.loop } : {}),
      ...(input.openCodeState ? { openCodeState: input.openCodeState } : {}),
    });
  }

  private async apply(input: {
    mode: CodingMode;
    userInput: string;
    analysis: BugAnalysis | UpgradeAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    errorLog?: string;
    patchApplier: PatchApplier;
    runId?: string;
    loop?: number;
    openCodeState?: OpenCodeFallbackState;
  }): Promise<string[]> {
    const context = await this.fileContext(input.patchPlan, input.patchApplier);
    let prompt = this.buildPatchPrompt(input, context);
    const openCodeChangedFiles = await this.tryOpenCodePatch(input, prompt);
    if (openCodeChangedFiles.length > 0) return openCodeChangedFiles;

    if (!this.provider) return [];
    prompt = this.buildPatchPrompt(input, context);

    const response = await this.provider.chat({
      model: this.model,
      messages: [createMessage({ role: 'user', content: redactSecrets(prompt, this.redact) })],
      temperature: this.temperature,
      maxTokens: 6000,
    });

    const patches = parsePatches(extractText(response.message.content));
    if (patches.length === 0) return [];
    return input.patchApplier.applyAll(patches);
  }

  private buildPatchPrompt(input: {
    mode: CodingMode;
    userInput: string;
    analysis: BugAnalysis | UpgradeAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    errorLog?: string;
    openCodeState?: OpenCodeFallbackState;
  }, context: string): string {
    return [
      `You are the Native OpenClaw ${input.mode} coding agent.`,
      'Return ONLY valid JSON with this shape:',
      '{"files":[{"path":"relative/file.ts","action":"create|update|delete","content":"full file content for create/update"}]}',
      'Rules:',
      '- Preserve existing architecture and unrelated behavior.',
      '- Do not edit .env, secrets, node_modules, dist, or .git.',
      '- For update/create, content must be the full new file content.',
      '- No markdown fences and no explanation.',
      '',
      `User request: ${input.userInput}`,
      `Analysis: ${JSON.stringify(input.analysis)}`,
      `Patch plan: ${JSON.stringify(input.patchPlan)}`,
      input.previousQa ? `Previous QA: ${JSON.stringify(input.previousQa)}` : '',
      input.errorLog ? `Error log: ${input.errorLog}` : '',
      input.openCodeState?.lastOutput
        ? `OpenCode output before fallback:\n${input.openCodeState.lastOutput}`
        : '',
      input.openCodeState?.lastSuggestion
        ? `OpenCode fallback note: ${input.openCodeState.lastSuggestion}`
        : '',
      `Current files:\n${context}`,
    ].filter(Boolean).join('\n\n');
  }

  private async tryOpenCodePatch(input: {
    mode: CodingMode;
    userInput: string;
    analysis: BugAnalysis | UpgradeAnalysis;
    patchPlan: PatchPlan;
    patchApplier: PatchApplier;
    runId?: string;
    loop?: number;
    openCodeState?: OpenCodeFallbackState;
  }, prompt: string): Promise<string[]> {
    if (!shouldUseOpenCode(input.mode)) return [];

    const logger = loggerFor(input.mode);
    const meta = {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.loop ? { loop: input.loop } : {}),
      mode: 'patch',
    };

    if (input.openCodeState?.unavailable) {
      logger.info('skipping opencode-agent for this run because it is unavailable', {
        ...meta,
        reason: input.openCodeState.unavailableReason,
      });
      return [];
    }

    logger.info('trying opencode-agent for patch', meta);
    if (input.openCodeState) {
      input.openCodeState.attempted = true;
      input.openCodeState.attempts = (input.openCodeState.attempts ?? 0) + 1;
    }

    const beforeState = await collectRepoState(input.patchApplier.root);
    for (const file of input.patchPlan.files) {
      await input.patchApplier.snapshotFile(file.path).catch(() => undefined);
    }

    try {
      const openCodeDirectMode = isOpenCodeDirectModeEnabled();
      const task = openCodeDirectMode
        ? input.userInput
        : [
            `Apply a repository patch for this Native OpenClaw ${input.mode} task.`,
            'You may edit files directly in the repository working directory.',
            'If you do not edit files directly, return ONLY the JSON patch object.',
            `Original request: ${input.userInput}`,
          ].join('\n');
      const result = await runOpenCodeAgent({
        mode: 'patch',
        cwd: input.patchApplier.root,
        task,
        ...(!openCodeDirectMode ? { context: redactSecrets(prompt, this.redact) } : {}),
      });

      const afterState = await collectRepoState(input.patchApplier.root);
      const directlyChanged = changedFilesBetween(beforeState, afterState);

      if (directlyChanged.length > 0) {
        for (const file of directlyChanged) {
          await input.patchApplier
            .snapshotOriginalContent(file, beforeState.get(file)?.content ?? null)
            .catch(() => undefined);
        }
        if (result.timedOut) {
          if (input.openCodeState) {
            input.openCodeState.lastError = result.error ?? result.summary;
            input.openCodeState.lastErrorType = 'timed-out-with-changes';
            input.openCodeState.lastSuggestion = 'QA will validate the files OpenCode changed before the timeout.';
          }
          logger.warn('opencode-agent timed out after changing files; continuing to QA', {
            ...meta,
            changedFiles: directlyChanged,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          });
        } else if (result.errorType === 'permission-rejected') {
          if (input.openCodeState) {
            input.openCodeState.lastError = result.error ?? result.summary;
            input.openCodeState.lastErrorType = 'permission-warning';
            input.openCodeState.lastSuggestion = 'OpenCode reported a permission rejection but changed files were detected; QA will validate the changes.';
          }
          logger.warn('opencode-agent reported permission rejection after changing files; continuing to QA', {
            ...meta,
            changedFiles: directlyChanged,
            exitCode: result.exitCode,
            errorType: result.errorType,
          });
        } else {
          logger.info('opencode-agent succeeded and changed files', {
            ...meta,
            changedFiles: directlyChanged,
            exitCode: result.exitCode,
          });
        }
        return directlyChanged;
      }

      if (!result.ok) {
        const error = result.error ?? result.summary;
        if (input.openCodeState) {
          input.openCodeState.fallbackUsed = true;
          input.openCodeState.lastError = error;
          if (result.errorType) input.openCodeState.lastErrorType = result.errorType;
          if (result.suggestion) input.openCodeState.lastSuggestion = result.suggestion;
          if (isOpenCodeEnvironmentFailure(result)) {
            input.openCodeState.unavailable = true;
            input.openCodeState.unavailableReason = error;
          }
        }
        logger.warn('opencode-agent failed, using internal CodingAgent fallback', {
          ...meta,
          error,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          errorType: result.errorType,
          suggestion: result.suggestion,
          fallback: 'internal-coding-agent',
        });
        return [];
      }

      const patches = tryParsePatches(result.stdout);
      if (patches.length > 0) {
        const changedFiles = await input.patchApplier.applyAll(patches);
        logger.info('opencode-agent succeeded with JSON patch output', {
          ...meta,
          changedFiles,
          exitCode: result.exitCode,
        });
        return changedFiles;
      }

      logger.warn('opencode-agent completed without detectable changes, using internal CodingAgent fallback', {
        ...meta,
        exitCode: result.exitCode,
        fallback: 'internal-coding-agent',
      });
      if (input.openCodeState) {
        input.openCodeState.fallbackUsed = true;
        const output = compactOpenCodeOutput([result.stdout, result.stderr].filter(Boolean).join('\n'), this.redact);
        if (output) input.openCodeState.lastOutput = output;
        input.openCodeState.lastSuggestion = output
          ? 'OpenCode completed without file changes; internal CodingAgent will use its output as fallback context.'
          : 'OpenCode completed without file changes; internal CodingAgent fallback will apply the patch plan.';
      }
      return [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (input.openCodeState) {
        input.openCodeState.fallbackUsed = true;
        if (/ENOENT|EACCES|EPERM|permission denied|not found|not recognized|cwd/i.test(message)) {
          input.openCodeState.unavailable = true;
          input.openCodeState.unavailableReason = message;
        }
      }
      logger.warn('opencode-agent failed, using internal CodingAgent fallback', {
        ...meta,
        error: message,
        fallback: 'internal-coding-agent',
      });
      return [];
    }
  }

  private async fileContext(plan: PatchPlan, patchApplier: PatchApplier): Promise<string> {
    const chunks: string[] = [];
    for (const file of plan.files.slice(0, 8)) {
      const content = await patchApplier.read(file.path);
      chunks.push([
        `FILE: ${file.path}`,
        `ACTION: ${file.action}`,
        content === null ? '(missing)' : content.slice(0, 5000),
      ].join('\n'));
    }
    return chunks.join('\n\n---\n\n');
  }
}
