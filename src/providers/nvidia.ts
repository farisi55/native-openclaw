/**
 * providers/nvidia.ts
 * Adapter for NVIDIA NIM chat completions.
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

const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const DEFAULT_TIMEOUT_MS = 120_000;

const KNOWN_MODELS: Record<string, StaticModelMeta> = {
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': {
    contextWindow: 131_072,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsVision: true,
  },
};

const DEFAULT_META: StaticModelMeta = {
  contextWindow: 131_072,
  maxOutputTokens: 65_536,
  supportsTools: true,
  supportsVision: false,
};

function metaForModel(model: string): StaticModelMeta {
  const known = KNOWN_MODELS[model];
  if (known) return known;
  return {
    ...DEFAULT_META,
    supportsVision: /\b(vision|vl|omni|multimodal)\b/i.test(model),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class NvidiaProvider extends BaseProvider {
  readonly id = 'nvidia';
  readonly displayName = 'NVIDIA NIM';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly timeoutMs: number;

  constructor() {
    super();
    this.apiKey = getEnv('NVIDIA_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] NVIDIA_API_KEY must not be empty.');
    this.baseUrl = (
      nonEmpty(getOptionalEnv('NVIDIA_BASE_URL')) ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
    this.defaultModel =
      nonEmpty(getOptionalEnv('NVIDIA_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = configuredProviderModels('NVIDIA', this.defaultModel);
    this.timeoutMs = positiveTimeout('NVIDIA_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
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
    const enableThinking = extra['enable_thinking'];
    delete extra['enable_thinking'];

    const existingTemplateKwargs = extra['chat_template_kwargs'];
    const chatTemplateKwargs = isRecord(existingTemplateKwargs)
      ? { ...existingTemplateKwargs }
      : {};
    if (typeof enableThinking === 'boolean') {
      chatTemplateKwargs['enable_thinking'] = enableThinking;
    }
    delete extra['chat_template_kwargs'];

    const body: WireChatRequest = {
      model: options.model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
    };

    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    Object.assign(body, extra);
    if (Object.keys(chatTemplateKwargs).length > 0) {
      body['chat_template_kwargs'] = chatTemplateKwargs;
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
    if (status === 401 || status === 403) return 'NVIDIA NIM authentication failed.';
    if (status === 404) return 'NVIDIA NIM endpoint or model was not found.';
    if (status === 408) return 'NVIDIA NIM request timed out.';
    if (status === 413) return 'NVIDIA NIM request was too large.';
    if (status === 429) return 'NVIDIA NIM rate limit exceeded.';
    if (status >= 500) return 'NVIDIA NIM is temporarily unavailable.';
    return `NVIDIA NIM request failed with HTTP ${status}.`;
  }
}
