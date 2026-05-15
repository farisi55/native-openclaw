/**
 * tools/index.ts — Barrel v9
 */
export { runWebFetch }       from './web-fetch';
export type { WebFetchResult } from './web-fetch';

export { runSystemTool }     from './system';
export type { SystemResult } from './system';

export { runApiClient }      from './api-client';
export type { ApiResult, ApiClientInput } from './api-client';

export { runSystemExecute, saveCustomCommand, listCustomCommands } from './system-execute';
export type { ExecuteResult, ExecuteInput, CustomCommand } from './system-execute';

export { browse, formatBrowsingResults } from './browsing';
export type { BrowsingResult, BrowsingItem } from './browsing';

export { ToolRegistry }      from './tool-registry';
export type { ToolManifest, RegisteredTool } from './tool-registry';

export { ToolExecutor }      from './tool-executor';
export type { ToolExecutionResult } from './tool-executor';

export { installTool, uninstallTool, listAvailable } from './tool-installer';
export type { InstallResult } from './tool-installer';
