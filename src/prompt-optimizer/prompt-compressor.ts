import { redactSecrets } from '../self-healing';
import type { PromptCompressionResult, PromptOptimizerMode } from './prompt-optimizer-types';

export interface PromptCompressorOptions {
  mode: PromptOptimizerMode;
  maxInputChars: number;
  maxContextChars: number;
  maxToolResultChars: number;
}

function uniqueLines(text: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const normalized = line.trim();
    if (!normalized) {
      if (lines[lines.length - 1] !== '') lines.push('');
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(line);
  }
  return lines.join('\n').trim();
}

function preserveImportantLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split(/\r?\n/);
  const important = lines.filter((line) =>
    /\b(?:error|failed|failure|request\s+too\s+large|telegram|polling|brevo|messageId|status|stack|token|context|konteks|cronjob|schedule|email)\b/i.test(line)
  );
  const head = lines.slice(0, 8);
  const tail = lines.slice(-8);
  const combined = uniqueLines([...head, ...important, ...tail].join('\n'));
  if (combined.length <= maxChars) return combined;
  const half = Math.max(200, Math.floor((maxChars - 80) / 2));
  return `${combined.slice(0, half)}\n...[compressed middle]...\n${combined.slice(-half)}`;
}

export class PromptCompressor {
  constructor(private readonly opts: PromptCompressorOptions) {}

  compress(input: { userInput: string; context?: string[] }): PromptCompressionResult {
    const originalContext = input.context ?? [];
    const originalChars = input.userInput.length + originalContext.reduce((sum, item) => sum + item.length, 0);
    const strictFactor = this.opts.mode === 'strict' ? 0.65 : 1;
    const maxInputChars = Math.max(1000, Math.floor(this.opts.maxInputChars * strictFactor));
    const maxContextChars = Math.max(1000, Math.floor(this.opts.maxContextChars * strictFactor));

    let compressedUserInput = redactSecrets(uniqueLines(input.userInput.trim()));
    compressedUserInput = preserveImportantLines(compressedUserInput, maxInputChars);

    const relevantContext: string[] = [];
    const droppedContext: PromptCompressionResult['droppedContext'] = [];
    let remainingContextChars = maxContextChars;

    for (const [index, rawContext] of originalContext.entries()) {
      const source = `context-${index + 1}`;
      const redacted = redactSecrets(uniqueLines(rawContext));
      const relevant =
        /\b(?:error|failed|request\s+too\s+large|telegram|brevo|email|cronjob|scheduler|tool|messageId|status|token|context|konteks)\b/i.test(redacted) ||
        index >= originalContext.length - 3;

      if (!relevant) {
        droppedContext.push({
          source,
          reason: 'old unrelated context',
          estimatedChars: rawContext.length,
        });
        continue;
      }

      const maxChunk = Math.min(this.opts.maxToolResultChars, remainingContextChars);
      if (maxChunk <= 0) {
        droppedContext.push({
          source,
          reason: 'context budget exhausted',
          estimatedChars: rawContext.length,
        });
        continue;
      }

      const compressed = preserveImportantLines(redacted, maxChunk);
      relevantContext.push(compressed);
      remainingContextChars -= compressed.length;
      if (compressed.length < rawContext.length) {
        droppedContext.push({
          source,
          reason: 'context compressed',
          estimatedChars: rawContext.length - compressed.length,
        });
      }
    }

    const compressedChars = compressedUserInput.length + relevantContext.reduce((sum, item) => sum + item.length, 0);
    return {
      compressedUserInput,
      relevantContext,
      droppedContext,
      compressionApplied: compressedChars < originalChars || droppedContext.length > 0,
      estimatedOriginalChars: originalChars,
      estimatedCompressedChars: compressedChars,
    };
  }
}
