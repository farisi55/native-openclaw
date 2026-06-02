import { policyBlock } from './senior-prompt-engineer-skill';
import type {
  CompiledPrompt,
  PromptCompressionResult,
  PromptOptimizerConfig,
  PromptReviewResult,
} from './prompt-optimizer-types';

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- none';
}

function routingHint(intent: PromptReviewResult['intent']): string | undefined {
  switch (intent) {
    case 'self-upgrade':
      return 'self-upgrade';
    case 'self-healing':
      return 'self-healing';
    case 'scheduler':
      return 'scheduler';
    case 'email':
      return 'email';
    case 'workspace':
      return 'workspace';
    case 'mcp':
      return 'mcp';
    case 'api':
      return 'api';
    case 'tool':
      return 'tool';
    default:
      return undefined;
  }
}

function outputRequirement(intent: PromptReviewResult['intent']): string {
  switch (intent) {
    case 'self-upgrade':
      return 'Return upgrade run summary, changed files, QA status, and restart status.';
    case 'self-healing':
      return 'Return healing diagnosis or healing run summary.';
    case 'email':
      return 'Execute required email tools first, then return Brevo verification result.';
    case 'scheduler':
      return 'Return scheduler action result and preserve timing details.';
    default:
      return 'Answer concisely and include only relevant details.';
  }
}

export class PromptCompiler {
  constructor(private readonly config: PromptOptimizerConfig) {}

  compile(review: PromptReviewResult, compression: PromptCompressionResult): CompiledPrompt {
    if (review.routingHint === 'simple-chat') {
      const optimizedInput = compression.compressedUserInput || review.normalizedInput;
      return {
        originalInput: review.originalInput,
        optimizedInput,
        intent: review.intent,
        routingHint: 'simple-chat',
        expectedOutputFormat: 'Answer briefly and directly.',
        tokenBudget: {
          estimatedInputChars: optimizedInput.length,
          maxInputChars: this.config.maxContextChars,
          compressionApplied: compression.compressionApplied,
        },
        requiredTools: [],
        excludedTools: review.excludedTools,
        metadata: {
          mode: this.config.mode,
          targetModelSmall: this.config.targetModelSmall,
          simpleChat: true,
          riskFlags: review.riskFlags,
          ambiguity: review.ambiguity,
          droppedContextCount: compression.droppedContext.length,
        },
      };
    }

    const contextBlock = compression.relevantContext.length > 0
      ? compression.relevantContext.map((item, index) => `Context ${index + 1}:\n${item}`).join('\n\n')
      : 'No additional context required.';
    const hint = review.routingHint ?? routingHint(review.intent);
    const expectedOutputFormat = outputRequirement(review.intent);
    const actionBlock = review.intent === 'self-upgrade'
      ? [
          ...review.requiredActions,
          'use SelfUpgradeEngine rather than normal chat',
          'include token budget, context compression, and tool-result truncation in the upgrade scope',
        ]
      : review.requiredActions;

    const optimizedInput = [
      `Task: ${review.taskGoal}`,
      '',
      `Original user request: ${compression.compressedUserInput}`,
      '',
      `Context:`,
      contextBlock,
      '',
      'Constraints:',
      bulletList(review.constraints),
      '',
      'Required action:',
      bulletList(actionBlock),
      '',
      'Tools/capabilities:',
      `Use: ${review.requiredTools.length > 0 ? review.requiredTools.join(', ') : 'none required'}`,
      `Do not use: ${review.excludedTools.length > 0 ? review.excludedTools.join(', ') : 'none'}`,
      '',
      `Output requirement: ${expectedOutputFormat}`,
      '',
      'Validation:',
      review.intent === 'email'
        ? '- brevo-email must execute successfully before claiming email delivery.'
        : review.intent === 'scheduler'
        ? '- schedule timing and email requirement must remain intact.'
        : review.intent === 'self-upgrade'
        ? '- SelfUpgradeEngine must own the change; no direct system-execute routing.'
        : '- response directly satisfies the user request.',
    ].join('\n');

    return {
      originalInput: review.originalInput,
      optimizedInput,
      intent: review.intent,
      ...(hint ? { routingHint: hint } : {}),
      systemAddendum: [
        'Prompt optimization policy:',
        policyBlock(),
        '',
        'Route according to routingHint and do not override strong action intent with generic chat.',
      ].join('\n'),
      expectedOutputFormat,
      tokenBudget: {
        estimatedInputChars: optimizedInput.length,
        maxInputChars: this.config.maxContextChars,
        compressionApplied: compression.compressionApplied,
      },
      requiredTools: review.requiredTools,
      excludedTools: review.excludedTools,
      metadata: {
        mode: this.config.mode,
        targetModelSmall: this.config.targetModelSmall,
        riskFlags: review.riskFlags,
        ambiguity: review.ambiguity,
        droppedContextCount: compression.droppedContext.length,
      },
    };
  }
}
