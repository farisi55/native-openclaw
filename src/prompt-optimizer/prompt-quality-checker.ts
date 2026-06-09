import type { CompiledPrompt, PromptOptimizationResult } from './prompt-optimizer-types';

const SECRET_RE = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|xkeysib-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9_-]{12,})\b/i;

function truncateMiddle(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  const half = Math.max(500, Math.floor((maxChars - 80) / 2));
  return `${input.slice(0, half)}\n...[prompt optimizer truncated middle]...\n${input.slice(-half)}`;
}

export class PromptQualityChecker {
  checkAndRepair(result: PromptOptimizationResult, maxChars: number): PromptOptimizationResult {
    let compiled: CompiledPrompt = result.compiled;
    let optimizedInput = compiled.optimizedInput.trim();
    const warnings: string[] = [];

    if (!optimizedInput) {
      optimizedInput = `Task: ${result.review.taskGoal}\n\nOriginal user request: ${result.review.normalizedInput}`;
      warnings.push('empty-optimized-input-repaired');
    }

    if (compiled.intent === 'self-upgrade' && compiled.routingHint !== 'self-upgrade') {
      compiled = { ...compiled, routingHint: 'self-upgrade' };
      warnings.push('self-upgrade-routing-repaired');
    }

    if (compiled.intent === 'self-healing' && compiled.routingHint !== 'self-healing') {
      compiled = { ...compiled, routingHint: 'self-healing' };
      warnings.push('self-healing-routing-repaired');
    }

    if (
      (compiled.intent === 'mcp-config-update' || compiled.intent === 'mcp-config-read') &&
      compiled.routingHint !== 'self-configuration'
    ) {
      compiled = { ...compiled, routingHint: 'self-configuration' };
      warnings.push('self-configuration-routing-repaired');
    }

    if (compiled.intent === 'email' && !/brevo-email/i.test(optimizedInput)) {
      optimizedInput += '\n\nEmail delivery rule: call brevo-email and verify ok=true before claiming sent.';
      warnings.push('email-brevo-rule-added');
    }

    if (compiled.intent === 'scheduler' && !/(\d+\s*(?:menit|jam|detik)|cronjob|jadwal|schedule|setiap|besok|nanti)/i.test(optimizedInput)) {
      optimizedInput += `\n\nSchedule-preservation: ${result.review.originalInput}`;
      warnings.push('scheduler-timing-restored');
    }

    if (SECRET_RE.test(optimizedInput)) {
      warnings.push('possible-secret-in-optimized-prompt');
    }

    if (optimizedInput.length > maxChars) {
      optimizedInput = truncateMiddle(optimizedInput, maxChars);
      warnings.push('prompt-truncated-to-budget');
    }

    const repairedCompiled: CompiledPrompt = {
      ...compiled,
      optimizedInput,
      tokenBudget: {
        ...compiled.tokenBudget,
        estimatedInputChars: optimizedInput.length,
        compressionApplied: compiled.tokenBudget.compressionApplied || warnings.includes('prompt-truncated-to-budget'),
      },
      metadata: {
        ...compiled.metadata,
        qualityWarnings: warnings,
      },
    };

    return {
      ...result,
      compiled: repairedCompiled,
    };
  }
}
