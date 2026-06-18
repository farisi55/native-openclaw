/**
 * providers/cohere.ts
 * Adapter for Cohere's OpenAI-compatible chat completions endpoint.
 */

import { getEnv, getEnvInt, getOptionalEnv } from '../config/env';
import { createMessage } from '../types/message';
import type { ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import { BaseProvider } from './base';
import { parseProviderModels } from './provider-env';

const DEFAULT_BASE_URL = 'https://api.cohere.ai/compatibility/v1';
const DEFAULT_MODEL = 'command-a-plus-05-2026';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 256_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveTimeout(key: string, fallback: number): number {
  const timeout = getEnvInt(key, fallback);
  if (timeout <= 0) throw new Error(`[env] Env var "${key}" must be a positive integer.`);
  return timeout;
}

export class CohereProvider extends BaseProvider {
  readonly id = 'cohere';
  readonly displayName = 'Cohere';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getEnv('COHERE_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] COHERE_API_KEY must not be empty.');
    this.baseUrl = (
      nonEmpty(getOptionalEnv('COHERE_BASE_URL')) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.defaultModel = nonEmpty(getOptionalEnv('COHERE_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = parseProviderModels(
      nonEmpty(getOptionalEnv('COHERE_MODELS')),
      this.defaultModel
    );
    this.timeoutMs = positiveTimeout('COHERE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(
      this.baseUrl,
      this.apiKey,
      options,
      { Accept: 'application/json' },
      this.timeoutMs
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((id): ModelInfo => ({
      id,
      name: id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      supportsTools: true,
      supportsVision: /\bvision\b|image/i.test(id),
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
    if (status === 401 || status === 403) return 'Cohere authentication failed.';
    if (status === 404) return 'Cohere endpoint or model was not found.';
    if (status === 408) return 'Cohere request timed out.';
    if (status === 413) return 'Cohere request was too large.';
    if (status === 429) return 'Cohere rate limit exceeded.';
    if (status >= 500) return 'Cohere is temporarily unavailable.';
    return `Cohere request failed with HTTP ${status}.`;
  }
}
