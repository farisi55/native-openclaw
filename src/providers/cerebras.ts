/**
 * providers/cerebras.ts
 * Adapter for Cerebras Inference chat completions.
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

const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1';
const DEFAULT_MODEL = 'gemma-4-31b';
const DEFAULT_TIMEOUT_MS = 120_000;

const KNOWN_MODELS: Record<string, StaticModelMeta> = {
  'gemma-4-31b': {
    contextWindow: 131_072,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: false,
  },
};

const DEFAULT_META: StaticModelMeta = {
  contextWindow: 131_072,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsVision: false,
};

function metaForModel(model: string): StaticModelMeta {
  return KNOWN_MODELS[model] ?? DEFAULT_META;
}

export class CerebrasProvider extends BaseProvider {
  readonly id = 'cerebras';
  readonly displayName = 'Cerebras';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getEnv('CEREBRAS_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] CEREBRAS_API_KEY must not be empty.');
    this.baseUrl = (
      nonEmpty(getOptionalEnv('CEREBRAS_BASE_URL')) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.defaultModel =
      nonEmpty(getOptionalEnv('CEREBRAS_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = configuredProviderModels('CEREBRAS', this.defaultModel);
    this.timeoutMs = positiveTimeout('CEREBRAS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
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
    const extra = { ...(options.extra ?? {}) };
    const body: WireChatRequest = {
      model: options.model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    Object.assign(body, extra);
    if (options.maxTokens !== undefined && body['max_completion_tokens'] === undefined) {
      body['max_completion_tokens'] = options.maxTokens;
    }
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
    if (status === 401 || status === 403) return 'Cerebras authentication failed.';
    if (status === 404) return 'Cerebras endpoint or model was not found.';
    if (status === 408) return 'Cerebras request timed out.';
    if (status === 413) return 'Cerebras request was too large.';
    if (status === 429) return 'Cerebras rate limit exceeded.';
    if (status >= 500) return 'Cerebras is temporarily unavailable.';
    return `Cerebras request failed with HTTP ${status}.`;
  }
}
