/**
 * providers/llamacpp.ts
 * Adapter for llama.cpp server OpenAI-compatible API.
 *
 * Optional env vars:
 *   LLAMACPP_BASE_URL      (default: http://llama-cpp:8091)
 *   LLAMACPP_DEFAULT_MODEL (default: qwen2.5-0.5b-instruct-q4_k_m.gguf)
 *   LLAMACPP_MODELS        (comma-separated model list)
 *   LLAMACPP_TIMEOUT_MS    (default: 120000)
 */

import { ProviderError, type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnvInt, getOptionalEnv } from '../config/env';
import { now } from '../utils/helpers';
import { networkFetch } from '../network';
import { BaseProvider, type WireChatRequest, type WireChatResponse, type WireModelsResponse } from './base';
import { parseProviderModels } from './provider-env';

const DEFAULT_BASE_URL = 'http://llama-cpp:8091';
const DEFAULT_MODEL = 'qwen2.5-0.5b-instruct-q4_k_m.gguf';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 8192;

interface LlamaCppFetchOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class LlamaCppProvider extends BaseProvider {
  readonly id = 'llamacpp';
  readonly displayName = 'llama.cpp Server';

  private readonly baseUrl: string;
  private readonly baseUrls: string[];
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.baseUrl = normalizeBaseUrl(
      getOptionalEnv('LLAMACPP_BASE_URL', DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL
    );
    this.baseUrls = this.resolveBaseUrls(this.baseUrl);
    this.defaultModel = getOptionalEnv('LLAMACPP_DEFAULT_MODEL', DEFAULT_MODEL) ?? DEFAULT_MODEL;
    this.models = parseProviderModels(getOptionalEnv('LLAMACPP_MODELS'), this.defaultModel);
    this.timeoutMs = getEnvInt('LLAMACPP_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    if (this.timeoutMs <= 0) {
      throw new Error('[env] LLAMACPP_TIMEOUT_MS must be a positive integer.');
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const startedAt = now();
    const model = options.model ?? this.defaultModel;
    const body: WireChatRequest = {
      model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      ...(options.extra ?? {}),
    };

    this.logger.debug('chat request', {
      provider: this.id,
      model,
      messageCount: body.messages.length,
    });

    const data = await this.fetchLlamaCppJson<WireChatResponse>('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
      timeoutMs: this.timeoutMs,
    });

    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!choice) throw new ProviderError(this.id, 'UNKNOWN', 'llama.cpp returned no choices.');
    if (!choice.message || typeof choice.message.content !== 'string' || !choice.message.content.trim()) {
      throw new ProviderError(this.id, 'UNKNOWN', 'llama.cpp returned an empty assistant message.');
    }

    const latencyMs = now() - startedAt;
    return this.buildChatResponse({
      message: this.fromWireMessage(choice.message),
      model: data.model ?? model,
      latencyMs,
      usage: this.normaliseUsage(data.usage),
      raw: data as Record<string, unknown>,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    let servedModels: ModelInfo[] = [];
    try {
      const data = await this.fetchLlamaCppJson<WireModelsResponse>('/v1/models', {
        method: 'GET',
        timeoutMs: this.timeoutMs,
      });
      servedModels = (data.data ?? [])
        .map((model) => typeof model.id === 'string' ? model.id : '')
        .filter(Boolean)
        .map((id) => this.toModelInfo(id));
    } catch {
      return this.configuredModels();
    }

    const configured = this.configuredModels();
    const seen = new Set(servedModels.map((model) => model.id));
    return [...servedModels, ...configured.filter((model) => !seen.has(model.id))];
  }

  override async healthCheck(): Promise<boolean> {
    for (const baseUrl of this.baseUrls) {
      try {
        const response = await networkFetch(`${baseUrl}/health`, { method: 'GET' });
        if (response.ok) return true;
      } catch {
        // Try OpenAI-compatible model listing next.
      }

      try {
        const response = await networkFetch(`${baseUrl}/v1/models`, { method: 'GET' });
        if (response.ok) return true;
      } catch {
        // Try the next candidate.
      }
    }
    return false;
  }

  protected override httpErrorMessage(status: number, body: string): string {
    if (status === 404) {
      return 'llama.cpp endpoint or model was not found. Check LLAMACPP_BASE_URL and model name.';
    }
    if (status === 413) {
      return 'llama.cpp request was too large. Reduce context or LLAMACPP_CTX_SIZE/model settings.';
    }
    if (status === 408) {
      return 'llama.cpp request timed out.';
    }
    if (status === 429) {
      return 'llama.cpp rate limit exceeded.';
    }
    if (status >= 500) {
      return 'llama.cpp server is unavailable.';
    }
    return `llama.cpp request failed with HTTP ${status}: ${body.slice(0, 300)}`;
  }

  private configuredModels(): ModelInfo[] {
    return this.models.map((model) => this.toModelInfo(model));
  }

  private toModelInfo(id: string): ModelInfo {
    return {
      id,
      name: id,
      contextWindow: getEnvInt('LLAMACPP_CTX_SIZE', DEFAULT_CONTEXT_WINDOW),
      supportsTools: false,
      supportsVision: false,
    };
  }

  private resolveBaseUrls(primary: string): string[] {
    const urls = [primary];

    try {
      const parsed = new URL(primary);
      const port = parsed.port ? `:${parsed.port}` : ':8091';
      const protocol = parsed.protocol || 'http:';
      const host = parsed.hostname.toLowerCase();

      if (host === 'llama-cpp' || host === 'host.docker.internal') {
        urls.push(`${protocol}//localhost${port}`);
        urls.push(`${protocol}//127.0.0.1${port}`);
      } else if (host === 'localhost') {
        urls.push(`${protocol}//127.0.0.1${port}`);
      } else if (host === '127.0.0.1') {
        urls.push(`${protocol}//localhost${port}`);
      }
    } catch {
      // Validator catches invalid URLs when enabled. Keep the primary value so
      // fetchJson returns the normal provider error if construction continues.
    }

    return [...new Set(urls.map((url) => normalizeBaseUrl(url)))];
  }

  private async fetchLlamaCppJson<T>(path: string, opts: LlamaCppFetchOptions): Promise<T> {
    let firstError: unknown;

    for (const baseUrl of this.baseUrls) {
      try {
        return await this.fetchJson<T>(`${baseUrl}${path}`, opts);
      } catch (error) {
        firstError ??= error;
        this.logger.debug('llamacpp endpoint failed', {
          provider: this.id,
          baseUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw firstError;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}
