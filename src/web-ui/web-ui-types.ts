import type { ApiDependencies } from '../api/types';

export interface WebUiConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  sessionSecret: string;
  cookieName: string;
  sessionTtlMs: number;
  puter: WebUiPuterConfig;
}

export interface WebUiDependencies extends ApiDependencies {}

export interface WebUiPuterConfig {
  enabled: boolean;
  providerId: string;
  defaultModel: string;
}

export interface WebUiPublicConfig {
  appName: string;
  puter: WebUiPuterConfig;
}

export interface StartedWebUiServer {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface WebUiChatResponse {
  ok: boolean;
  result: string;
  model: string | null;
  provider: string | null;
  responseTime: string;
  tools: string[];
  sessionId: string | null;
  error: string | null;
  preferredProvider?: string | null;
  preferredModel?: string | null;
  fallbackUsed?: boolean;
}
