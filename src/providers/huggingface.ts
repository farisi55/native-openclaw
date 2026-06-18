/**
 * providers/huggingface.ts
 * Adapter for Hugging Face Router OpenAI-compatible chat completions.
 */

import { getEnvInt, getOptionalEnv } from '../config/env';
import { createMessage } from '../types/message';
import type { ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import { BaseProvider } from './base';
import { parseProviderModels } from './provider-env';

const DEFAULT_BASE_URL = 'https://router.huggingface.co/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-120b:fastest';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getHuggingFaceApiKey(): string {
  const apiKey =
    nonEmpty(getOptionalEnv('HUGGINGFACE_API_KEY')) ??
    nonEmpty(getOptionalEnv('HF_API_KEY')) ??
    nonEmpty(getOptionalEnv('HF_TOKEN'));
  if (!apiKey) {
    throw new Error('[env] HUGGINGFACE_API_KEY, HF_API_KEY, or HF_TOKEN must not be empty.');
  }
  return apiKey;
}

function positiveTimeout(key: string, fallback: number): number {
  const timeout = getEnvInt(key, fallback);
  if (timeout <= 0) throw new Error(`[env] Env var "${key}" must be a positive integer.`);
  return timeout;
}

export class HuggingFaceProvider extends BaseProvider {
  readonly id = 'huggingface';
  readonly displayName = 'Hugging Face Router';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getHuggingFaceApiKey();
    this.baseUrl = (
      nonEmpty(getOptionalEnv('HUGGINGFACE_BASE_URL')) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.defaultModel =
      nonEmpty(getOptionalEnv('HUGGINGFACE_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = parseProviderModels(
      nonEmpty(getOptionalEnv('HUGGINGFACE_MODELS')),
      this.defaultModel
    );
    this.timeoutMs = positiveTimeout('HUGGINGFACE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
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
    if (status === 401 || status === 403) return 'Hugging Face authentication failed.';
    if (status === 404) return 'Hugging Face endpoint or model was not found.';
    if (status === 408) return 'Hugging Face request timed out.';
    if (status === 413) return 'Hugging Face request was too large.';
    if (status === 429) return 'Hugging Face rate limit exceeded.';
    if (status >= 500) return 'Hugging Face is temporarily unavailable.';
    return `Hugging Face request failed with HTTP ${status}.`;
  }
}
