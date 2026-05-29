import type { IProvider } from '../types/provider';
import { createMessage, extractText } from '../types/message';
import type { BugAnalysis, CommandRunResult, QAReport, UpgradeAnalysis } from './healing-types';

function stripJsonFences(text: string): string {
  return text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stripJsonFences(text)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export class BugAnalyzerAgent {
  constructor(
    private readonly provider?: IProvider,
    private readonly model = 'default',
    private readonly temperature = 0.1
  ) {}

  async analyze(input: {
    userInput: string;
    errorLog?: string;
    targetFiles?: string[];
    previousQa?: QAReport;
    previousCommands?: CommandRunResult[];
  }): Promise<BugAnalysis> {
    if (this.provider) {
      const prompt = [
        'Output ONLY valid JSON with keys summary, likelyCause, affectedFiles, fixStrategy, confidence.',
        'Diagnose this Native OpenClaw bug. Do not include secrets.',
        `User request: ${input.userInput}`,
        input.errorLog ? `Error log:\n${input.errorLog}` : '',
        input.previousQa ? `Previous QA:\n${JSON.stringify(input.previousQa)}` : '',
        input.targetFiles?.length ? `Target files: ${input.targetFiles.join(', ')}` : '',
      ].filter(Boolean).join('\n\n');

      try {
        const response = await this.provider.chat({
          model: this.model,
          messages: [createMessage({ role: 'user', content: prompt })],
          temperature: this.temperature,
          maxTokens: 900,
        });
        const record = parseRecord(extractText(response.message.content));
        if (record) {
          return {
            summary: typeof record['summary'] === 'string' ? record['summary'] : 'Bug analysis generated.',
            likelyCause: typeof record['likelyCause'] === 'string' ? record['likelyCause'] : 'Unknown cause.',
            affectedFiles: stringArray(record['affectedFiles']),
            fixStrategy: typeof record['fixStrategy'] === 'string' ? record['fixStrategy'] : 'Apply a focused fix and rerun QA.',
            confidence: typeof record['confidence'] === 'number' ? Math.max(0, Math.min(1, record['confidence'])) : 0.5,
          };
        }
      } catch {
        // Fall back to deterministic analysis below.
      }
    }

    return {
      summary: 'Automated bug analysis fallback.',
      likelyCause: input.previousQa?.summary ?? input.errorLog?.slice(0, 300) ?? 'The requested behavior is failing QA.',
      affectedFiles: input.targetFiles ?? [],
      fixStrategy: 'Apply a small, targeted source change, then run the configured build and test commands.',
      confidence: 0.35,
    };
  }

  async analyzeUpgrade(input: {
    userInput: string;
    missingCapability?: string;
    previousQa?: QAReport;
  }): Promise<UpgradeAnalysis> {
    return {
      summary: 'Automated self-upgrade analysis.',
      missingCapability: input.missingCapability ?? input.userInput,
      feasible: true,
      targetFiles: [],
      implementationStrategy: input.previousQa
        ? `Revise implementation based on QA: ${input.previousQa.summary}`
        : 'Add the smallest code change that implements the requested capability and include tests when appropriate.',
      confidence: 0.35,
    };
  }
}
