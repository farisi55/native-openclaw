/**
 * providers/ollama.ts
 * Adapter for Ollama — local model server (no API key required).
 * API ref: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Optional env vars:
 *   OLLAMA_BASE_URL  (default: http://localhost:11434)
 */

import { createMessage, extractText } from '../types/message';
import { ProviderError, type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getOptionalEnv } from '../config/env';
import { now } from '../utils/helpers';
import { BaseProvider } from './base';
import { networkFetch } from '../network';

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

// ─── Provider ─────────────────────────────────────────────────────────────────

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  readonly displayName = 'Ollama (local)';

  private readonly baseUrl: string;

  constructor() {
    super();
    this.baseUrl = (
      getOptionalEnv('OLLAMA_BASE_URL', 'http://localhost:11434') ?? 'http://localhost:11434'
    ).replace(/\/$/, '');
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

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const startedAt = now();

    const ollamaOpts: Record<string, unknown> = {};
    if (options.temperature !== undefined) ollamaOpts['temperature'] = options.temperature;
    if (options.maxTokens !== undefined) ollamaOpts['num_predict'] = options.maxTokens;
    if (options.extra) Object.assign(ollamaOpts, options.extra);

    const body: OllamaChatRequest = {
      model: options.model,
      messages: this.toOllamaMessages(options.messages, options.systemPrompt),
      stream: false,
      ...(Object.keys(ollamaOpts).length > 0 && { options: ollamaOpts }),
    };

    this.logger.debug('chat request', { provider: this.id, model: options.model });

    const data = await this.fetchJson<OllamaChatResponse>(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
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
      data = await this.fetchJson<OllamaTagsResponse>(`${this.baseUrl}/api/tags`, {
        method: 'GET',
      });
    } catch {
      return [];
    }
    return (data.models ?? []).map((m): ModelInfo => ({
      id: m.name,
      name: m.name,
      contextWindow: 8192,
      supportsTools: false,
      supportsVision:
        m.name.toLowerCase().includes('vision') || m.name.toLowerCase().includes('llava'),
      raw: m as unknown as Record<string, unknown>,
    }));
  }

  override async healthCheck(): Promise<boolean> {
    try {
      const r = await networkFetch(`${this.baseUrl}/`, { method: 'GET' });
      return r.ok;
    } catch {
      return false;
    }
  }
}
