import type { IProvider } from '../types/provider';
import { createMessage, extractText } from '../types/message';
import type {
  BugAnalysis,
  GeneratedFilePatch,
  PatchPlan,
  QAReport,
  UpgradeAnalysis,
} from './healing-types';
import { PatchApplier } from './patch-applier';
import { redactSecrets } from './log-redactor';

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
  }): Promise<string[]> {
    return this.apply({
      mode: 'self-healing',
      userInput: input.userInput,
      analysis: input.analysis,
      patchPlan: input.patchPlan,
      ...(input.previousQa ? { previousQa: input.previousQa } : {}),
      ...(input.errorLog ? { errorLog: input.errorLog } : {}),
      patchApplier: input.patchApplier,
    });
  }

  async applyUpgrade(input: {
    userInput: string;
    analysis: UpgradeAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    patchApplier: PatchApplier;
  }): Promise<string[]> {
    return this.apply({
      mode: 'self-upgrade',
      userInput: input.userInput,
      analysis: input.analysis,
      patchPlan: input.patchPlan,
      ...(input.previousQa ? { previousQa: input.previousQa } : {}),
      patchApplier: input.patchApplier,
    });
  }

  private async apply(input: {
    mode: 'self-healing' | 'self-upgrade';
    userInput: string;
    analysis: BugAnalysis | UpgradeAnalysis;
    patchPlan: PatchPlan;
    previousQa?: QAReport;
    errorLog?: string;
    patchApplier: PatchApplier;
  }): Promise<string[]> {
    if (!this.provider) return [];

    const context = await this.fileContext(input.patchPlan, input.patchApplier);
    const prompt = [
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
      `Current files:\n${context}`,
    ].filter(Boolean).join('\n\n');

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
