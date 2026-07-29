/**
 * providers/requesty.ts
 * Adapter for Requesty AI Router OpenAI-compatible chat completions.
 */

import { getEnv, getOptionalEnv } from '../config/env';
import { createMessage } from '../types/message';
import type { ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import { BaseProvider, type WireChatRequest } from './base';
import {
  configuredProviderModels,
  mergeLiveAndConfiguredModels,
  modelInfoFromId,
  nonEmpty,
  positiveTimeout,
  type StaticModelMeta,
} from './openai-compatible-utils';

const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1';
const DEFAULT_MODEL = 'google/gemma-4-31b-it';
const DEFAULT_TIMEOUT_MS = 120_000;

const KNOWN_MODELS: Record<string, StaticModelMeta> = {
  'google/gemma-4-31b-it': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: false,
  },
  'google/gemini-2.5-pro': {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
  },
  'google/gemini-2.5-flash': {
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
  },
  'openai/gpt-5': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  },
  'openai/gpt-5-mini': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  },
  'anthropic/claude-sonnet-4': {
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  },
  'anthropic/claude-opus-4': {
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  },
};

const DEFAULT_META: StaticModelMeta = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsVision: false,
};

function metaForModel(model: string): StaticModelMeta {
  const known = KNOWN_MODELS[model];
  if (known) return known;
  return {
    ...DEFAULT_META,
    supportsVision: /\b(vision|vl|omni|multimodal|gemini|gpt-5|claude)\b/i.test(model),
  };
}

export class RequestyProvider extends BaseProvider {
  readonly id = 'requesty';
  readonly displayName = 'Requesty AI';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getEnv('REQUESTY_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] REQUESTY_API_KEY must not be empty.');
    this.baseUrl = (
      nonEmpty(getOptionalEnv('REQUESTY_BASE_URL')) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.defaultModel =
      nonEmpty(getOptionalEnv('REQUESTY_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = configuredProviderModels('REQUESTY', this.defaultModel);
    this.timeoutMs = positiveTimeout('REQUESTY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChatWithBody(
      this.baseUrl,
      this.apiKey,
      options,
      this.buildBody(options),
      { Accept: 'application/json' },
      this.timeoutMs
    );
  }

  private buildBody(options: ChatOptions): WireChatRequest {
    const body: WireChatRequest = {
      model: options.model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    Object.assign(body, options.extra ?? {});
    body.stream = false;
    return body;
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const liveModels = await this.openAiCompatListModels(
        this.baseUrl,
        this.apiKey,
        { Accept: 'application/json' }
      );
      return mergeLiveAndConfiguredModels(liveModels, this.models, metaForModel);
    } catch {
      return this.models.map((id) => modelInfoFromId(id, metaForModel(id)));
    }
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
    if (status === 401 || status === 403) return 'Requesty AI authentication failed.';
    if (status === 404) return 'Requesty AI endpoint or model was not found.';
    if (status === 408) return 'Requesty AI request timed out.';
    if (status === 413) return 'Requesty AI request was too large.';
    if (status === 429) return 'Requesty AI rate limit exceeded.';
    if (status >= 500) return 'Requesty AI is temporarily unavailable.';
    return `Requesty AI request failed with HTTP ${status}.`;
  }
}
