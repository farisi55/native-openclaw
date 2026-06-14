/**
 * config/validator.ts
 * Zod-based config schema + validator.
 */

import { z } from 'zod';
import { getOptionalEnv, getEnvInt, getEnvFloat } from './env';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ProviderConfigSchema = z.object({
  apiKey: z.string().min(1, 'API key must not be empty'),
  baseUrl: z.string().url(),
  defaultModel: z.string().min(1),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const AgentConfigSchema = z.object({
  maxTurns: z.number().int().min(1).max(200),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(128_000),
  systemPrompt: z.string().min(1),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const StorageConfigSchema = z.object({
  backend: z.enum(['file', 'memory']),
  dataDir: z.string().min(1),
});
export type StorageConfig = z.infer<typeof StorageConfigSchema>;

const WorkspaceConfigSchema = z.object({
  dir: z.string().min(1),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

const ApiConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  authToken: z.string().optional(),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

const TelegramConfigSchema = z.object({
  enabled: z.boolean(),
  botToken: z.string().optional(),
  allowedChatIds: z.string(),
  allowAll: z.boolean(),
  ackEnabled: z.boolean(),
  ackMessage: z.string(),
  processTimeoutMs: z.number().int().min(1),
  logPollingErrors: z.boolean(),
  retryMinMs: z.number().int().min(1),
  retryMaxMs: z.number().int().min(1),
  pollTimeoutSeconds: z.number().int().min(1),
  queueNoticeEnabled: z.boolean(),
});
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;

const NetworkConfigSchema = z.object({
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  noProxy: z.string(),
  dnsServers: z.string(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

const McpConfigSchema = z.object({
  enabled: z.boolean(),
  configPath: z.string().min(1),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

const AppConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  providers: z.object({
    openai: ProviderConfigSchema.optional(),
    anthropic: ProviderConfigSchema.optional(),
    gemini: ProviderConfigSchema.optional(),
    zai: ProviderConfigSchema.optional(),
  }),
  agent: AgentConfigSchema,
  storage: StorageConfigSchema,
  workspace: WorkspaceConfigSchema,
  api: ApiConfigSchema,
  telegram: TelegramConfigSchema,
  network: NetworkConfigSchema,
  mcp: McpConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Builder ──────────────────────────────────────────────────────────────────

function buildProviderConfig(
  prefix: string,
  defaultBaseUrl: string,
  defaultModel: string,
  modelEnvKey = `${prefix}_DEFAULT_MODEL`
): ProviderConfig | undefined {
  const apiKey = getOptionalEnv(`${prefix}_API_KEY`);
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: getOptionalEnv(`${prefix}_BASE_URL`, defaultBaseUrl) ?? defaultBaseUrl,
    defaultModel: getOptionalEnv(modelEnvKey, defaultModel) ?? defaultModel,
  };
}

function parseBoolEnv(key: string, fallback: boolean): boolean {
  return ['true', '1', 'yes'].includes((getOptionalEnv(key, String(fallback)) ?? String(fallback)).toLowerCase());
}

function validatePositiveTimeout(key: string): void {
  const raw = getOptionalEnv(key)?.trim();
  if (!raw) return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[config] ${key} must be a positive integer.`);
  }
}

function validateProviderEnvironment(): void {
  validatePositiveTimeout('CLOUDFLARE_TIMEOUT_MS');
  validatePositiveTimeout('GITHUB_MODELS_TIMEOUT_MS');

  if (parseBoolEnv('CLOUDFLARE_AI_ENABLED', false)) {
    if (!getOptionalEnv('CLOUDFLARE_API_KEY')?.trim()) {
      throw new Error(
        '[config] CLOUDFLARE_API_KEY is required when CLOUDFLARE_AI_ENABLED=true.'
      );
    }
    const accountId = getOptionalEnv('CLOUDFLARE_ACCOUNT_ID')?.trim();
    if (!accountId) {
      throw new Error(
        '[config] CLOUDFLARE_ACCOUNT_ID is required when CLOUDFLARE_AI_ENABLED=true.'
      );
    }

    const configuredUrl = getOptionalEnv('CLOUDFLARE_BASE_URL')?.trim();
    if (configuredUrl) {
      try {
        new URL(configuredUrl.replace(/\$\{CLOUDFLARE_ACCOUNT_ID\}/g, accountId));
      } catch {
        throw new Error('[config] CLOUDFLARE_BASE_URL must be a valid URL.');
      }
    }
  }

  if (parseBoolEnv('GITHUB_MODELS_ENABLED', false)) {
    if (!getOptionalEnv('GITHUB_MODELS_API_KEY')?.trim()) {
      throw new Error(
        '[config] GITHUB_MODELS_API_KEY is required when GITHUB_MODELS_ENABLED=true.'
      );
    }
    if (
      parseBoolEnv('GITHUB_MODELS_USE_ORG_ENDPOINT', false) &&
      !getOptionalEnv('GITHUB_MODELS_ORG')?.trim()
    ) {
      throw new Error(
        '[config] GITHUB_MODELS_ORG is required when GITHUB_MODELS_USE_ORG_ENDPOINT=true.'
      );
    }

    const configuredUrl = getOptionalEnv('GITHUB_MODELS_BASE_URL')?.trim();
    if (configuredUrl) {
      try {
        new URL(configuredUrl);
      } catch {
        throw new Error('[config] GITHUB_MODELS_BASE_URL must be a valid URL.');
      }
    }
  }
}

function buildRawConfig(): unknown {
  // FIX: exactOptionalPropertyTypes — use conditional spread instead of || undefined
  const apiAuthToken = getOptionalEnv('API_AUTH_TOKEN');
  const telegramBotToken = getOptionalEnv('TELEGRAM_BOT_TOKEN');
  const httpProxy = getOptionalEnv('HTTP_PROXY') || getOptionalEnv('http_proxy');
  const httpsProxy = getOptionalEnv('HTTPS_PROXY') || getOptionalEnv('https_proxy');

  return {
    env: getOptionalEnv('APP_ENV', 'development'),
    logLevel: getOptionalEnv('LOG_LEVEL', 'info'),
    providers: {
      openai: buildProviderConfig('OPENAI', 'https://api.openai.com/v1', 'gpt-4o'),
      anthropic: buildProviderConfig('ANTHROPIC', 'https://api.anthropic.com', 'claude-opus-4-20250514'),
      gemini: buildProviderConfig('GEMINI', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.0-flash'),
      zai: buildProviderConfig('ZAI', 'https://api.z.ai/api/paas/v4', 'glm-4.5', 'ZAI_MODEL'),
    },
    agent: {
      maxTurns: getEnvInt('AGENT_MAX_TURNS', 20),
      temperature: getEnvFloat('AGENT_TEMPERATURE', 0.7),
      maxTokens: getEnvInt('AGENT_MAX_TOKENS', 4096),
      systemPrompt: getOptionalEnv('AGENT_SYSTEM_PROMPT', 'You are a helpful AI assistant.'),
    },
    storage: {
      backend: getOptionalEnv('STORAGE_BACKEND', 'file'),
      dataDir: getOptionalEnv('APP_DATA_DIR', '.data'),
    },
    workspace: {
      dir: getOptionalEnv('WORKSPACE_DIR', './workspace'),
    },
    // FIX: use conditional spread — never pass 'undefined' to an optional key
    api: {
      enabled: parseBoolEnv('API_ENABLED', false),
      host: getOptionalEnv('API_HOST', '127.0.0.1'),
      port: getEnvInt('API_PORT', 18789),
      ...(apiAuthToken ? { authToken: apiAuthToken } : {}),
    },
    telegram: {
      enabled: parseBoolEnv('TELEGRAM_ENABLED', false),
      ...(telegramBotToken ? { botToken: telegramBotToken } : {}),
      allowedChatIds: getOptionalEnv('TELEGRAM_ALLOWED_CHAT_IDS', '') ?? '',
      allowAll: parseBoolEnv('TELEGRAM_ALLOW_ALL', false),
      ackEnabled: parseBoolEnv('TELEGRAM_ACK_ENABLED', true),
      ackMessage: getOptionalEnv('TELEGRAM_ACK_MESSAGE', 'Sedang diproses...') ?? 'Sedang diproses...',
      processTimeoutMs: getEnvInt('TELEGRAM_PROCESS_TIMEOUT_MS', 90_000),
      logPollingErrors: parseBoolEnv('TELEGRAM_LOG_POLLING_ERRORS', false),
      retryMinMs: getEnvInt('TELEGRAM_RETRY_MIN_MS', 3_000),
      retryMaxMs: getEnvInt('TELEGRAM_RETRY_MAX_MS', 60_000),
      pollTimeoutSeconds: getEnvInt('TELEGRAM_POLL_TIMEOUT', 25),
      queueNoticeEnabled: parseBoolEnv('TELEGRAM_QUEUE_NOTICE_ENABLED', false),
    },
    network: {
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      noProxy: getOptionalEnv('NO_PROXY', '') ?? '',
      dnsServers: getOptionalEnv('DNS_SERVERS', '') ?? '',
    },
    mcp: {
      enabled: parseBoolEnv('MCP_ENABLED', true),
      configPath: getOptionalEnv('MCP_CONFIG_PATH', './mcp_agent.config.yaml') ?? './mcp_agent.config.yaml',
    },
  };
}

// ─── Validate ─────────────────────────────────────────────────────────────────

export function validateConfig(): Readonly<AppConfig> {
  validateProviderEnvironment();
  const raw = buildRawConfig();
  const result = AppConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[config] Validation failed:\n${issues}`);
  }

  const cfg = result.data;

  const hasLegacyProvider =
    cfg.providers.openai || cfg.providers.anthropic || cfg.providers.gemini || cfg.providers.zai;
  const hasExternalProvider =
    Boolean(process.env['GROQ_API_KEY']) ||
    Boolean(process.env['MISTRAL_API_KEY']) ||
    Boolean(process.env['OPENROUTER_API_KEY']) ||
    Boolean(process.env['ZAI_API_KEY']) ||
    Boolean(process.env['PUTER_API_KEY']) ||
    (
      parseBoolEnv('CLOUDFLARE_AI_ENABLED', false) &&
      Boolean(process.env['CLOUDFLARE_API_KEY'])
    ) ||
    (
      parseBoolEnv('GITHUB_MODELS_ENABLED', false) &&
      Boolean(process.env['GITHUB_MODELS_API_KEY'])
    );
  const hasOllama = Boolean(process.env['OLLAMA_BASE_URL']);

  if (!hasLegacyProvider && !hasExternalProvider && !hasOllama) {
    throw new Error(
      '[config] No provider API keys found. Set at least one of:\n' +
        '  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,\n' +
        '  GROQ_API_KEY, MISTRAL_API_KEY, OPENROUTER_API_KEY, ZAI_API_KEY, PUTER_API_KEY,\n' +
        '  CLOUDFLARE_API_KEY with CLOUDFLARE_AI_ENABLED=true,\n' +
        '  GITHUB_MODELS_API_KEY with GITHUB_MODELS_ENABLED=true,\n' +
        '  or OLLAMA_BASE_URL'
    );
  }

  return Object.freeze(cfg);
}
