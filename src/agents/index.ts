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

export { getSystemContext } from './system-context';
export type { SystemContextInput } from './system-context';

export { handleAction } from './action-handler';
export type { ActionContext, ActionResult } from './action-handler';

export { extractMemory } from './memory-extractor';
export type { MemoryUpdate, MemoryScope } from './memory-extractor';

export { parseLLMToolCall } from '../tools/tool-executor';
export type { ToolExecutionResult } from '../tools/tool-executor';
