/**
 * Cloudflare Workers AI provider.
 * Uses Cloudflare's OpenAI-compatible chat completions endpoint.
 */

import { getEnv, getEnvInt, getOptionalEnv } from '../config/env';
import type { ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import { createMessage } from '../types/message';
import { BaseProvider } from './base';
import { parseProviderModels } from './provider-env';

const DEFAULT_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveTimeout(key: string, fallback: number): number {
  const timeout = getEnvInt(key, fallback);
  if (timeout <= 0) throw new Error(`[env] Env var "${key}" must be a positive integer.`);
  return timeout;
}

function normalizeCloudflareModel(model: string): string {
  return model
    .trim()
    .replace(/^https?:\/\/[^/]+\/client\/v4\/accounts\/[^/]+\/ai\/run\//i, '')
    .replace(/^\/?ai\/run\//i, '')
    .replace(/^\/+/, '');
}

function normalizeCloudflareBaseUrl(configuredUrl: string | undefined, accountId: string): string {
  const defaultUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  if (!configuredUrl) return defaultUrl;

  let url = configuredUrl
    .replace(/\$\{CLOUDFLARE_ACCOUNT_ID\}/g, accountId)
    .replace(/\/+$/, '');

  url = url.replace(/\/chat\/completions$/i, '');

  if (/\/client\/v4\/accounts$/i.test(url)) {
    return `${url}/${accountId}/ai/v1`;
  }
  if (/\/client\/v4\/accounts\/[^/]+$/i.test(url)) {
    return `${url}/ai/v1`;
  }
  if (/\/ai\/run$/i.test(url)) {
    return url.replace(/\/ai\/run$/i, '/ai/v1');
  }
  if (/\/ai$/i.test(url)) {
    return `${url}/v1`;
  }

  return url;
}

export class CloudflareProvider extends BaseProvider {
  readonly id = 'cloudflare';
  readonly displayName = 'Cloudflare Workers AI';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getEnv('CLOUDFLARE_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] CLOUDFLARE_API_KEY must not be empty.');
    const accountId = getEnv('CLOUDFLARE_ACCOUNT_ID').trim();
    if (!accountId) throw new Error('[env] CLOUDFLARE_ACCOUNT_ID must not be empty.');

    this.defaultModel = normalizeCloudflareModel(
      nonEmpty(getOptionalEnv('CLOUDFLARE_DEFAULT_MODEL')) ?? DEFAULT_MODEL
    );
    const configuredModels = nonEmpty(getOptionalEnv('CLOUDFLARE_MODELS'))
      ?.split(',')
      .map(normalizeCloudflareModel)
      .filter(Boolean)
      .join(',');
    this.models = parseProviderModels(
      configuredModels,
      this.defaultModel
    );
    this.timeoutMs = positiveTimeout('CLOUDFLARE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

    const configuredBaseUrl = nonEmpty(getOptionalEnv('CLOUDFLARE_BASE_URL'));
    this.baseUrl = normalizeCloudflareBaseUrl(configuredBaseUrl, accountId);
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(
      this.baseUrl,
      this.apiKey,
      {
        ...options,
        model: normalizeCloudflareModel(options.model),
      },
      { Accept: 'application/json' },
      this.timeoutMs
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((id): ModelInfo => ({
      id,
      name: id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsVision: false,
    }));
  }

  override async healthCheck(): Promise<boolean> {
    try {
      await this.chat({
        model: this.defaultModel,
        messages: [createMessage({ role: 'user', content: 'Reply with exactly: OK' })],
        temperature: 0,
        maxTokens: 4,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected override httpErrorMessage(status: number, _body: string): string {
    if (status === 401 || status === 403) {
      return 'Cloudflare Workers AI authentication failed.';
    }
    if (status === 404) {
      return 'Cloudflare Workers AI endpoint or model was not found.';
    }
    if (status === 408) return 'Cloudflare Workers AI request timed out.';
    if (status === 413) return 'Cloudflare Workers AI request was too large.';
    if (status === 429) return 'Cloudflare Workers AI rate limit exceeded.';
    if (status >= 500) return 'Cloudflare Workers AI is temporarily unavailable.';
    return `Cloudflare Workers AI request failed with HTTP ${status}.`;
  }
}
