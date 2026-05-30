import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import { PromptCompressor } from './prompt-compressor';
import { PromptCompiler } from './prompt-compiler';
import { PromptOptimizerStore } from './prompt-optimizer-store';
import type {
  PromptOptimizationApiMetadata,
  PromptOptimizationResult,
  PromptOptimizationRunSummary,
  PromptOptimizerConfig,
  PromptOptimizerInput,
  PromptOptimizerMode,
} from './prompt-optimizer-types';
import { PromptQualityChecker } from './prompt-quality-checker';
import { PromptReviewEngine } from './prompt-review-engine';

export type {
  CompiledPrompt,
  OptimizedIntent,
  PromptCompressionResult,
  PromptOptimizationApiMetadata,
  PromptOptimizationResult,
  PromptOptimizationRunSummary,
  PromptOptimizerConfig,
  PromptOptimizerInput,
  PromptOptimizerMode,
  PromptReviewResult,
} from './prompt-optimizer-types';
export { PromptCompressor } from './prompt-compressor';
export { PromptCompiler } from './prompt-compiler';
export { PromptOptimizerStore } from './prompt-optimizer-store';
export { PromptQualityChecker } from './prompt-quality-checker';
export { PromptReviewEngine, userRequiresEmail } from './prompt-review-engine';

const logger = createLogger('prompt:optimizer');

function parseMode(value: string | undefined): PromptOptimizerMode {
  if (value === 'off' || value === 'fast' || value === 'balanced' || value === 'strict') {
    return value;
  }
  return 'balanced';
}

export function loadPromptOptimizerConfig(
  overrides: Partial<PromptOptimizerConfig> = {}
): PromptOptimizerConfig {
  const mode = parseMode(getOptionalEnv('PROMPT_OPTIMIZER_MODE', 'balanced'));
  const enabled = getEnvBool('PROMPT_OPTIMIZER_ENABLED', true) && mode !== 'off';
  const configuredModel = getOptionalEnv('PROMPT_OPTIMIZER_MODEL');
  const model = overrides.model ?? configuredModel;
  const resolvedMode = overrides.mode ?? mode;
  return {
    enabled: overrides.enabled ?? enabled,
    mode: resolvedMode,
    ...(model ? { model } : {}),
    maxInputChars: overrides.maxInputChars ?? getEnvInt('PROMPT_OPTIMIZER_MAX_INPUT_CHARS', 12_000),
    maxContextChars: overrides.maxContextChars ?? getEnvInt('PROMPT_OPTIMIZER_MAX_CONTEXT_CHARS', 24_000),
    maxToolResultChars: overrides.maxToolResultChars ?? getEnvInt('PROMPT_OPTIMIZER_MAX_TOOL_RESULT_CHARS', 8_000),
    targetModelSmall: overrides.targetModelSmall ?? getEnvBool('PROMPT_OPTIMIZER_TARGET_MODEL_SMALL', true),
    logSummary: overrides.logSummary ?? getEnvBool('PROMPT_OPTIMIZER_LOG_SUMMARY', true),
    storeRuns: overrides.storeRuns ?? getEnvBool('PROMPT_OPTIMIZER_STORE_RUNS', process.env['APP_ENV'] === 'test' ? false : true),
    dataDir: overrides.dataDir ?? getOptionalEnv('APP_DATA_DIR') ?? './data',
  };
}

export function toPromptOptimizationApiMetadata(
  result: PromptOptimizationResult | null
): PromptOptimizationApiMetadata | undefined {
  if (!result) return undefined;
  const metadata: PromptOptimizationApiMetadata = {
    enabled: true,
    intent: result.compiled.intent,
    originalChars: result.compression.estimatedOriginalChars,
    optimizedChars: result.compiled.optimizedInput.length,
    compressionApplied: result.compiled.tokenBudget.compressionApplied,
    ...(result.compiled.routingHint ? { routingHint: result.compiled.routingHint } : {}),
  };
  return metadata;
}

export class PromptOptimizer {
  private readonly reviewEngine = new PromptReviewEngine();
  private readonly compressor: PromptCompressor;
  private readonly compiler: PromptCompiler;
  private readonly checker = new PromptQualityChecker();
  private readonly store: PromptOptimizerStore;

  constructor(private readonly config: PromptOptimizerConfig = loadPromptOptimizerConfig()) {
    this.compressor = new PromptCompressor({
      mode: config.mode,
      maxInputChars: config.maxInputChars,
      maxContextChars: config.maxContextChars,
      maxToolResultChars: config.maxToolResultChars,
    });
    this.compiler = new PromptCompiler(config);
    this.store = new PromptOptimizerStore(config.dataDir);
  }

  getConfig(): PromptOptimizerConfig {
    return { ...this.config };
  }

  getStore(): PromptOptimizerStore {
    return this.store;
  }

  async optimize(input: PromptOptimizerInput): Promise<PromptOptimizationResult | null> {
    if (!this.config.enabled || this.config.mode === 'off') return null;

    const review = this.reviewEngine.review(input.userInput);
    const compression = this.compressor.compress(input);
    const compiled = this.compiler.compile(review, compression);
    const result = this.checker.checkAndRepair(
      { review, compression, compiled },
      this.config.maxContextChars
    );

    const summary: PromptOptimizationRunSummary = {
      timestamp: new Date().toISOString(),
      enabled: true,
      intent: result.compiled.intent,
      originalChars: result.compression.estimatedOriginalChars,
      optimizedChars: result.compiled.optimizedInput.length,
      compressionApplied: result.compiled.tokenBudget.compressionApplied,
      droppedContextCount: result.compression.droppedContext.length,
      ...(result.compiled.routingHint ? { routingHint: result.compiled.routingHint } : {}),
    };

    if (this.config.logSummary) {
      logger.info('prompt optimized', {
        intent: summary.intent,
        originalChars: summary.originalChars,
        optimizedChars: summary.optimizedChars,
        compressionApplied: summary.compressionApplied,
        routingHint: summary.routingHint ?? null,
      });
    }

    if (this.config.storeRuns) {
      void this.store.append(summary).catch((err: unknown) => {
        logger.warn('prompt optimizer store write failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return result;
  }
}

export function createPromptOptimizerFromEnv(
  overrides: Partial<PromptOptimizerConfig> = {}
): PromptOptimizer {
  return new PromptOptimizer(loadPromptOptimizerConfig(overrides));
}
