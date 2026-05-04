/**
 * agents/index.ts
 * Barrel — re-exports the agent layer.
 */

export { PromptBuilder, buildSystemPrompt } from './prompt-builder';
export type { PromptBuilderOptions } from './prompt-builder';

export { MessageAssembler, assembleMessages, roughTokenEstimate } from './message-assembler';
export type { AssembleOptions, AssembledMessages } from './message-assembler';

export { Orchestrator } from './orchestrator';
export type { OrchestratorOptions, TurnInput, TurnResult } from './orchestrator';
