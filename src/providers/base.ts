/**
 * providers/base.ts
 * Abstract base class shared by all provider adapters.
 */

import { createMessage, extractText } from '../types/message';
import {
  ProviderError,
  type IProvider,
  type ChatOptions,
  type ChatResponse,
  type ModelInfo,
  type ProviderErrorCode,
  type TokenUsage,
} from '../types/provider';
import type { Message } from '../types/message';
import { createLogger } from '../utils/logger';
import { now } from '../utils/helpers';
import { networkFetch } from '../network';

// ─── OpenAI-compatible wire types ─────────────────────────────────────────────

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface WireChatRequest {
  model: string;
  messages: WireMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: false;
  [key: string]: unknown;
}

export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface WireChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    message: WireMessage;
    finish_reason?: string;
  }>;
  usage?: WireUsage;
  [key: string]: unknown;
}

export interface WireModel {
  id: string;
  object?: string;
  [key: string]: unknown;
}

export interface WireModelsResponse {
  data: WireModel[];
  object?: string;
}

// ─── Internal fetch options type ──────────────────────────────────────────────

interface FetchOpts {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 90_000;

// ─── Abstract Base ────────────────────────────────────────────────────────────

export abstract class BaseProvider implements IProvider {
  abstract readonly id: string;
  abstract readonly displayName: string;

  protected readonly logger = createLogger('provider');

  // ── Fetch helper ────────────────────────────────────────────────────────────

  protected async fetchJson<T>(url: string, opts: FetchOpts): Promise<T> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = opts;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const signal = callerSignal
      ? this.combineSignals(callerSignal, controller.signal)
      : controller.signal;

    try {
      const init: RequestInit = { method: rest.method, signal };
      if (rest.headers) init.headers = rest.headers;
      if (rest.body !== undefined) init.body = rest.body;

      const response = await networkFetch(url, init);
      clearTimeout(timer);

      if (!response.ok) await this.handleHttpError(response);

      return (await response.json()) as T;
    } catch (cause) {
      clearTimeout(timer);
      if (cause instanceof ProviderError) throw cause;
      throw this.wrapFetchError(cause);
    }
  }

  private async handleHttpError(response: Response): Promise<never> {
    let body: string;
    try { body = await response.text(); } catch { body = '(unreadable)'; }
    const code = this.httpStatusToCode(response.status);
    throw new ProviderError(
      this.id, code,
      `HTTP ${response.status}: ${body.slice(0, 300)}`,
      { status: response.status, body }
    );
  }

  protected httpStatusToCode(status: number): ProviderErrorCode {
    if (status === 401 || status === 403) return 'UNAUTHORIZED';
    if (status === 429) return 'RATE_LIMITED';
    if (status === 404) return 'MODEL_NOT_FOUND';
    if (status === 400) return 'CONTEXT_EXCEEDED';
    if (status === 422) return 'CONTENT_FILTERED';
    return status >= 500 ? 'NETWORK_ERROR' : 'UNKNOWN';
  }

  private wrapFetchError(cause: unknown): ProviderError {
    if (cause instanceof Error && cause.name === 'AbortError') {
      return new ProviderError(this.id, 'TIMEOUT', 'Request timed out.', cause);
    }
    return new ProviderError(
      this.id, 'NETWORK_ERROR',
      cause instanceof Error ? cause.message : String(cause),
      cause
    );
  }

  /**
   * Combines multiple AbortSignals into one.
   * The returned signal aborts when ANY input signal aborts.
   * All event listeners are properly cleaned up to prevent memory leaks.
   */
  private combineSignals(...signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
    }

    const cleanup: Array<() => void> = [];

    for (const signal of signals) {
      const onAbort = (): void => {
        controller.abort(signal.reason);
        for (const fn of cleanup) fn();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', onAbort));
    }

    controller.signal.addEventListener('abort', () => {
      for (const fn of cleanup) fn();
    }, { once: true });

    return controller.signal;
  }

  // ── Message mapping ─────────────────────────────────────────────────────────

  protected toWireMessages(messages: Message[], systemPrompt?: string): WireMessage[] {
    const wire: WireMessage[] = [];
    if (systemPrompt) wire.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      wire.push({
        role: msg.role as WireMessage['role'],
        content: extractText(msg.content),
      });
    }
    return wire;
  }

  protected fromWireMessage(wire: WireMessage): Message {
    return createMessage({ role: 'assistant', content: wire.content ?? '' });
  }

  // ── Usage normalisation ─────────────────────────────────────────────────────

  protected normaliseUsage(usage?: WireUsage): TokenUsage | undefined {
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
      totalTokens: usage.total_tokens ?? 0,
    };
  }

  // ── Build ChatResponse safely (respects exactOptionalPropertyTypes) ─────────

  protected buildChatResponse(
    fields: {
      message: Message;
      model: string;
      latencyMs: number;
      usage?: TokenUsage | undefined;
      raw?: Record<string, unknown> | undefined;
    }
  ): ChatResponse {
    const r: ChatResponse = {
      message: fields.message,
      model: fields.model,
      latencyMs: fields.latencyMs,
    };
    if (fields.usage !== undefined) r.usage = fields.usage;
    if (fields.raw !== undefined) r.raw = fields.raw;
    return r;
  }

  // ── OpenAI-compatible chat ──────────────────────────────────────────────────

  protected async openAiCompatChat(
    baseUrl: string,
    apiKey: string,
    options: ChatOptions,
    extraHeaders?: Record<string, string>
  ): Promise<ChatResponse> {
    const startedAt = now();

    const body: WireChatRequest = {
      model: options.model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
      ...(options.temperature !== undefined && { temperature: options.temperature }),
      ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      ...(options.extra ?? {}),
    };

    this.logger.debug('chat request', {
      provider: this.id,
      model: options.model,
      messageCount: body.messages.length,
    });

    const data = await this.fetchJson<WireChatResponse>(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    const choice = data.choices[0];
    if (!choice) throw new ProviderError(this.id, 'UNKNOWN', 'API returned no choices.');

    const message = this.fromWireMessage(choice.message);
    const latencyMs = now() - startedAt;

    this.logger.debug('chat response', { provider: this.id, model: data.model ?? options.model, latencyMs });

    return this.buildChatResponse({
      message,
      model: data.model ?? options.model,
      latencyMs,
      usage: this.normaliseUsage(data.usage),
      raw: data as Record<string, unknown>,
    });
  }

  // ── OpenAI-compatible listModels ────────────────────────────────────────────

  protected async openAiCompatListModels(
    baseUrl: string,
    apiKey: string,
    extraHeaders?: Record<string, string>
  ): Promise<WireModel[]> {
    const data = await this.fetchJson<WireModelsResponse>(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, ...extraHeaders },
    });
    return data.data ?? [];
  }

  // ── Default health check ────────────────────────────────────────────────────

  async healthCheck(): Promise<boolean> {
    try {
      return (await this.listModels()).length > 0;
    } catch {
      return false;
    }
  }

  abstract chat(options: ChatOptions): Promise<ChatResponse>;
  abstract listModels(): Promise<ModelInfo[]>;
}
