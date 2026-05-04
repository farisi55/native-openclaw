/**
 * config/validator.ts
 * Zod-based config schema + validator.
 * Produces a typed, frozen AppConfig on success.
 */

import { z } from 'zod';
import {
  getOptionalEnv,
  getEnvInt,
  getEnvFloat,
} from './env';

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

const AppConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test']),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
  providers: z.object({
    openai: ProviderConfigSchema.optional(),
    anthropic: ProviderConfigSchema.optional(),
    gemini: ProviderConfigSchema.optional(),
  }),
  agent: AgentConfigSchema,
  storage: StorageConfigSchema,
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ─── Builder ──────────────────────────────────────────────────────────────────

function buildProviderConfig(
  prefix: string,
  defaultBaseUrl: string,
  defaultModel: string
): ProviderConfig | undefined {
  const apiKey = getOptionalEnv(`${prefix}_API_KEY`);
  if (!apiKey) return undefined;

  return {
    apiKey,
    baseUrl: getOptionalEnv(`${prefix}_BASE_URL`, defaultBaseUrl) ?? defaultBaseUrl,
    defaultModel:
      getOptionalEnv(`${prefix}_DEFAULT_MODEL`, defaultModel) ?? defaultModel,
  };
}

function buildRawConfig(): unknown {
  return {
    env: getOptionalEnv('APP_ENV', 'development'),
    logLevel: getOptionalEnv('LOG_LEVEL', 'info'),
    providers: {
      openai: buildProviderConfig(
        'OPENAI',
        'https://api.openai.com/v1',
        'gpt-4o'
      ),
      anthropic: buildProviderConfig(
        'ANTHROPIC',
        'https://api.anthropic.com',
        'claude-opus-4-20250514'
      ),
      gemini: buildProviderConfig(
        'GEMINI',
        'https://generativelanguage.googleapis.com/v1beta',
        'gemini-2.0-flash'
      ),
    },
    agent: {
      maxTurns: getEnvInt('AGENT_MAX_TURNS', 20),
      temperature: getEnvFloat('AGENT_TEMPERATURE', 0.7),
      maxTokens: getEnvInt('AGENT_MAX_TOKENS', 4096),
      systemPrompt: getOptionalEnv(
        'AGENT_SYSTEM_PROMPT',
        'You are a helpful AI assistant.'
      ),
    },
    storage: {
      backend: getOptionalEnv('STORAGE_BACKEND', 'file'),
      dataDir: getOptionalEnv('APP_DATA_DIR', '.data'),
    },
  };
}

// ─── Validate ─────────────────────────────────────────────────────────────────

/**
 * Load, validate and return the application config.
 * Throws with a descriptive message on validation failure.
 */
export function validateConfig(): Readonly<AppConfig> {
  const raw = buildRawConfig();
  const result = AppConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`[config] Validation failed:\n${issues}`);
  }

  const cfg = result.data;

  // Allow any configured provider — groq/mistral/openrouter/ollama are
  // read directly from env by their respective adapters, not from AppConfig.
  const hasLegacyProvider = cfg.providers.openai || cfg.providers.anthropic || cfg.providers.gemini;
  const hasExternalProvider =
    Boolean(process.env['GROQ_API_KEY']) ||
    Boolean(process.env['MISTRAL_API_KEY']) ||
    Boolean(process.env['OPENROUTER_API_KEY']);
  const hasOllama = Boolean(process.env['OLLAMA_BASE_URL']) || true; // always attempted

  if (!hasLegacyProvider && !hasExternalProvider && !hasOllama) {
    throw new Error(
      '[config] No provider API keys found. Set at least one of:\n' +
        '  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,\n' +
        '  GROQ_API_KEY, MISTRAL_API_KEY, or OPENROUTER_API_KEY'
    );
  }

  return Object.freeze(cfg);
}
