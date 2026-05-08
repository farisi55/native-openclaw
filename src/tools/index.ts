/**
 * tools/index.ts
 * Barrel — re-exports tool modules.
 */

export { runWebFetch } from './web-fetch';
export type { WebFetchResult } from './web-fetch';

export { runSystemTool } from './system';
export type { SystemResult } from './system';

export { runApiClient } from './api-client';
export type { ApiResult } from './api-client';

export { ToolRegistry } from './tool-registry';
export type { ToolManifest, RegisteredTool } from './tool-registry';

export { ToolExecutor, parseLLMToolCall } from './tool-executor';
export type { ToolExecutionResult } from './tool-executor';

export { installTool, uninstallTool, listAvailable } from './tool-installer';
export type { InstallResult } from './tool-installer';
