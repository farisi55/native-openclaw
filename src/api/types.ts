import type { Orchestrator } from '../agents/orchestrator';
import type { ProviderRegistry, IProvider } from '../types/provider';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager } from '../storage/session-manager';
import type { SettingsManager } from '../storage/settings-manager';
import type { ToolRegistry } from '../tools/tool-registry';
import type { McpManager } from '../mcp';
import type { SchedulerActionContext } from '../scheduler';
import type { SelfHealingActionContext } from '../self-healing';

export interface ApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  authToken?: string;
}

export interface ApiDependencies {
  providers: ProviderRegistry;
  skillRegistry: SkillRegistry;
  sessions: SessionManager;
  settings: SettingsManager;
  toolRegistry: ToolRegistry;
  orchestrator: Orchestrator;
  mcpManager?: McpManager;
  scheduler?: SchedulerActionContext;
  selfHealing?: SelfHealingActionContext;
}

export interface ApiRuntimeState {
  activeProvider: IProvider;
  activeModel: string;
  activeSessionId: string | null;
}

export interface ChatRequestBody {
  message?: unknown;
  sessionId?: unknown;
}

export interface ChatApiResponse {
  model: string | null;
  provider: string | null;
  result: string | null;
  token: string | null;
  responseTime: string;
  tools: string[];
  flow: Array<Record<string, unknown>>;
  sessionId: string | null;
  error_detail: string[];
}
