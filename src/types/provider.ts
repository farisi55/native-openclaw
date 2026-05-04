/**
 * provider.ts
 * Abstract provider interface — all LLM adapters must satisfy this contract.
 */

import type { Message } from './message';

// ─── Model Info ───────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  /** Maximum tokens the model can emit in a single response. */
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
  /** Raw provider-specific fields. */
  raw?: Record<string, unknown>;
}

// ─── Chat Options ─────────────────────────────────────────────────────────────

export interface ChatOptions {
  model: string;
  messages: Message[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Abort signal for cancellation support. */
  signal?: AbortSignal;
  /** Extra provider-specific parameters passed through verbatim. */
  extra?: Record<string, unknown>;
}

// ─── Chat Response ────────────────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  /** The generated assistant message (role is always 'assistant'). */
  message: Message;
  /** Token usage if reported by the provider. */
  usage?: TokenUsage;
  /** Which model actually served the request (may differ from requested). */
  model: string;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Provider-specific raw response, for debugging. */
  raw?: Record<string, unknown>;
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/**
 * IProvider — the unified contract every LLM adapter implements.
 *
 * Implementing classes MUST:
 * - Return a fully-formed ChatResponse from `chat()`.
 * - Return at least one ModelInfo entry from `listModels()`.
 * - Surface provider errors as `ProviderError` (defined below).
 */
export interface IProvider {
  /** Unique identifier used in config and CLI (e.g. "openai", "anthropic"). */
  readonly id: string;

  /** Human-readable display name. */
  readonly displayName: string;

  /**
   * Send a chat completion request.
   * Rejects with ProviderError on API failure.
   */
  chat(options: ChatOptions): Promise<ChatResponse>;

  /**
   * Return the list of models available from this provider.
   * May perform a live API call or return a static list.
   */
  listModels(): Promise<ModelInfo[]>;

  /**
   * Optional health check — returns true if the provider is reachable
   * and the API key is valid.
   */
  healthCheck?(): Promise<boolean>;
}

// ─── Provider Error ───────────────────────────────────────────────────────────

export type ProviderErrorCode =
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'CONTEXT_EXCEEDED'
  | 'MODEL_NOT_FOUND'
  | 'CONTENT_FILTERED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(`[${providerId}] ${message}`);
    this.name = 'ProviderError';
  }

  isRetryable(): boolean {
    return this.code === 'RATE_LIMITED' || this.code === 'NETWORK_ERROR';
  }
}

// ─── Provider Registry Type ───────────────────────────────────────────────────

/** Map of provider id → IProvider instance. Populated at bootstrap. */
export type ProviderRegistry = Map<string, IProvider>;
