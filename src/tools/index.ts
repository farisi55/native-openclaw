/**
 * tools/index.ts — Barrel v9
 */
export { runWebFetch }       from './web-fetch';
export type { WebFetchResult } from './web-fetch';

export { runSystemTool }     from './system';
export type { SystemResult } from './system';

export { runApiClient }      from './api-client';
export type { ApiResult, ApiClientInput } from './api-client';

export {
  classifyOpenCodeError,
  buildOpenCodeArgsPreview,
  previewOpenCodeArgs,
  runOpenCodeAgent,
  runOpenCodeDoctor,
  validateOpenCodeArgsTemplate,
} from './opencode-agent';
export type {
  OpenCodeAgentInput,
  OpenCodeAgentMode,
  OpenCodeAgentResult,
  OpenCodeArgsTemplateValidation,
  OpenCodeDoctorResult,
  OpenCodeErrorDiagnostic,
  OpenCodeErrorType,
} from './opencode-agent';
export {
  bootstrapOpenCodeAuthFromEnv,
  defaultOpenCodeAuthFile,
  getOpenCodeAuthStatus,
  openCodeAuthHasProvider,
  resolveOpenCodeAuthFile,
} from './opencode-auth';
export type {
  OpenCodeAuthBootstrapResult,
  OpenCodeAuthStatus,
} from './opencode-auth';
export {
  approveOpenCodeInstall,
  detectOpenCode,
  getOpenCodeInstallCommand,
  installOpenCode,
  rejectOpenCodeInstall,
} from './opencode-installer';
export type {
  OpenCodeDetectionResult,
  OpenCodeInstallCommand,
  OpenCodeInstallResult,
  OpenCodeInstallStrategy,
} from './opencode-installer';

export {
  approveCommand,
  classifyCommandRisk,
  listCustomCommands,
  listPendingCommandApprovals,
  rejectCommand,
  runSystemExecute,
  saveCustomCommand,
} from './system-execute';
export type {
  ApprovalStatus,
  CommandRiskAssessment,
  CommandRiskLevel,
  CustomCommand,
  ExecuteInput,
  ExecuteResult,
  PendingCommandApproval,
} from './system-execute';

export { browse, formatBrowsingResults } from './browsing';
export type { BrowsingResult, BrowsingItem } from './browsing';

export { ToolRegistry }      from './tool-registry';
export type { ToolManifest, RegisteredTool } from './tool-registry';

export { ToolExecutor }      from './tool-executor';
export type { ToolExecutionResult } from './tool-executor';

export { installTool, uninstallTool, listAvailable } from './tool-installer';
export type { InstallResult } from './tool-installer';

export { planCommand } from './command-planner';
export type { CommandPlanRequest, CommandPlanResult } from './command-planner';
