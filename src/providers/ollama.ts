/**
 * providers/ollama.ts
 * Adapter for Ollama — local model server (no API key required).
 * API ref: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Optional env vars:
 *   OLLAMA_BASE_URL      (default: http://localhost:11434)
 *   OLLAMA_DEFAULT_MODEL (default: qwen2.5:0.5b)
 *   OLLAMA_MODELS        (comma-separated model list)
 *   OLLAMA_TIMEOUT_MS    (default: 120000)
 */

import { createMessage, extractText } from '../types/message';
import { ProviderError, type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnvInt, getOptionalEnv } from '../config/env';
import { now } from '../utils/helpers';
import { BaseProvider } from './base';
import { networkFetch } from '../network';
import { parseProviderModels } from './provider-env';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:0.5b';
const DEFAULT_TIMEOUT_MS = 120_000;

// ─── Ollama wire types ────────────────────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: false;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagEntry {
  name: string;
  model: string;
  modified_at: string;
  size: number;
  details?: { parameter_size?: string; family?: string };
}

interface OllamaTagsResponse {
  models: OllamaTagEntry[];
}

interface OllamaFetchOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (local)';

  private readonly baseUrl: string;
  private readonly baseUrls: string[];
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.baseUrl = (
      getOptionalEnv('OLLAMA_BASE_URL', DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.baseUrls = this.resolveBaseUrls(this.baseUrl);
    this.defaultModel = getOptionalEnv('OLLAMA_DEFAULT_MODEL', DEFAULT_MODEL) ?? DEFAULT_MODEL;
    this.models = parseProviderModels(getOptionalEnv('OLLAMA_MODELS'), this.defaultModel);
    this.timeoutMs = getEnvInt('OLLAMA_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    if (this.timeoutMs <= 0) {
      throw new Error('[env] OLLAMA_TIMEOUT_MS must be a positive integer.');
    }
  }

  private toOllamaMessages(msgs: ChatOptions['messages'], systemPrompt?: string): OllamaMessage[] {
    const result: OllamaMessage[] = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    for (const msg of msgs) {
      const role: OllamaMessage['role'] =
        msg.role === 'tool' ? 'user' : (msg.role as OllamaMessage['role']);
      result.push({ role, content: extractText(msg.content) });
    }
    return result;
  }

  private resolveBaseUrls(primary: string): string[] {
    const urls = [primary];

    try {
      const parsed = new URL(primary);
      const port = parsed.port ? `:${parsed.port}` : ':11434';
      const protocol = parsed.protocol || 'http:';
      const host = parsed.hostname.toLowerCase();

      if (host === 'ollama' || host === 'host.docker.internal') {
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

    return [...new Set(urls.map((url) => url.replace(/\/$/, '')))];
  }

  private async fetchOllamaJson<T>(path: string, opts: OllamaFetchOptions): Promise<T> {
    let firstError: unknown;

    for (const baseUrl of this.baseUrls) {
      try {
        return await this.fetchJson<T>(`${baseUrl}${path}`, opts);
      } catch (error) {
        firstError ??= error;
        this.logger.debug('ollama endpoint failed', {
          provider: this.id,
          baseUrl,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw firstError;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const startedAt = now();
    const model = options.model ?? this.defaultModel;

    const ollamaOpts: Record<string, unknown> = {};
    if (options.temperature !== undefined) ollamaOpts['temperature'] = options.temperature;
    if (options.maxTokens !== undefined) ollamaOpts['num_predict'] = options.maxTokens;
    if (options.extra) Object.assign(ollamaOpts, options.extra);

    const body: OllamaChatRequest = {
      model,
      messages: this.toOllamaMessages(options.messages, options.systemPrompt),
      stream: false,
      ...(Object.keys(ollamaOpts).length > 0 && { options: ollamaOpts }),
    };

    this.logger.debug('chat request', { provider: this.id, model });

    const data = await this.fetchOllamaJson<OllamaChatResponse>('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
      timeoutMs: this.timeoutMs,
    });

    if (!data.message) {
      throw new ProviderError(this.id, 'UNKNOWN', 'Ollama returned no message.');
    }

    const message = createMessage({ role: 'assistant', content: data.message.content });
    const latencyMs = now() - startedAt;

    const hasUsage = data.prompt_eval_count !== undefined && data.eval_count !== undefined;

    return this.buildChatResponse({
      message,
      model: data.model,
      latencyMs,
      ...(hasUsage && {
        usage: {
          promptTokens: data.prompt_eval_count!,
          completionTokens: data.eval_count!,
          totalTokens: data.prompt_eval_count! + data.eval_count!,
        },
      }),
      raw: data as unknown as Record<string, unknown>,
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    let data: OllamaTagsResponse;
    try {
      data = await this.fetchOllamaJson<OllamaTagsResponse>('/api/tags', {
        method: 'GET',
        timeoutMs: this.timeoutMs,
      });
    } catch {
      return this.configuredModels();
    }
    const installed = (data.models ?? []).map((m): ModelInfo => this.toModelInfo(m.name, m as unknown as Record<string, unknown>));
    const configured = this.configuredModels();
    const seen = new Set(installed.map((model) => model.id));
    return [...installed, ...configured.filter((model) => !seen.has(model.id))];
  }

  override async healthCheck(): Promise<boolean> {
    for (const baseUrl of this.baseUrls) {
      try {
        const r = await networkFetch(`${baseUrl}/`, { method: 'GET' });
        if (r.ok) return true;
      } catch {
        // Try the next candidate.
      }
    }
    return false;
  }

  private configuredModels(): ModelInfo[] {
    return this.models.map((model) => this.toModelInfo(model));
  }

  private toModelInfo(id: string, raw?: Record<string, unknown>): ModelInfo {
    return {
      id,
      name: id,
      contextWindow: 8192,
      supportsTools: false,
      supportsVision:
        id.toLowerCase().includes('vision') || id.toLowerCase().includes('llava'),
      ...(raw ? { raw } : {}),
    };
  }
}
