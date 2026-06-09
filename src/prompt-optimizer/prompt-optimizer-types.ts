export type PromptOptimizerMode = 'off' | 'fast' | 'balanced' | 'strict';

export type OptimizedIntent =
  | 'chat'
  | 'tool'
  | 'self-healing'
  | 'self-upgrade'
  | 'scheduler'
  | 'email'
  | 'workspace'
  | 'api'
  | 'mcp'
  | 'mcp-config-update'
  | 'mcp-config-read'
  | 'unknown';

export interface PromptReviewResult {
  originalInput: string;
  normalizedInput: string;
  intent: OptimizedIntent;
  routingHint?: string;
  taskGoal: string;
  constraints: string[];
  requiredTools: string[];
  excludedTools: string[];
  requiredActions: string[];
  riskFlags: string[];
  ambiguity: {
    isAmbiguous: boolean;
    clarificationQuestion?: string;
  };
}

export interface PromptCompressionResult {
  compressedUserInput: string;
  relevantContext: string[];
  droppedContext: Array<{
    source: string;
    reason: string;
    estimatedChars: number;
  }>;
  compressionApplied: boolean;
  estimatedOriginalChars: number;
  estimatedCompressedChars: number;
}

export interface CompiledPrompt {
  originalInput: string;
  optimizedInput: string;
  intent: OptimizedIntent;
  routingHint?: string;
  systemAddendum?: string;
  expectedOutputFormat?: string;
  tokenBudget: {
    estimatedInputChars: number;
    maxInputChars: number;
    maxOutputTokens?: number;
    compressionApplied: boolean;
  };
  requiredTools: string[];
  excludedTools: string[];
  metadata: Record<string, unknown>;
}

export interface PromptOptimizationResult {
  review: PromptReviewResult;
  compression: PromptCompressionResult;
  compiled: CompiledPrompt;
}

export interface PromptOptimizerConfig {
  enabled: boolean;
  mode: PromptOptimizerMode;
  model?: string;
  maxInputChars: number;
  maxContextChars: number;
  maxToolResultChars: number;
  targetModelSmall: boolean;
  logSummary: boolean;
  storeRuns: boolean;
  dataDir: string;
}

export interface PromptOptimizerInput {
  userInput: string;
  context?: string[];
}

export interface PromptOptimizationApiMetadata {
  enabled: boolean;
  intent: OptimizedIntent;
  originalChars: number;
  optimizedChars: number;
  compressionApplied: boolean;
  routingHint?: string;
}

export interface PromptOptimizationRunSummary extends PromptOptimizationApiMetadata {
  timestamp: string;
  droppedContextCount: number;
}
