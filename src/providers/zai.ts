/**
 * providers/zai.ts
 * Adapter for Z.ai — OpenAI-compatible API.
 *
 * Required env vars:
 *   ZAI_API_KEY
 *
 * Optional env vars:
 *   ZAI_BASE_URL  (default: https://api.z.ai/api/paas/v4)
 *   ZAI_MODEL     (default: glm-4.5)
 */

import { type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { BaseProvider, type WireModel } from './base';

interface ZaiModelMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const DEFAULT_MODEL = 'glm-4.5';

const KNOWN_MODELS: Record<string, ZaiModelMeta> = {
  'glm-4.5': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: false,
  },
};

const DEFAULT_META: ZaiModelMeta = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: true,
  supportsVision: false,
};

export class ZaiProvider extends BaseProvider {
  readonly id = 'zai';
  readonly displayName = 'Z.ai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor() {
    super();
    this.apiKey = getEnv('ZAI_API_KEY');
    this.baseUrl = (
      getOptionalEnv('ZAI_BASE_URL', 'https://api.z.ai/api/paas/v4') ??
      'https://api.z.ai/api/paas/v4'
    ).replace(/\/$/, '');
    this.defaultModel = getOptionalEnv('ZAI_MODEL', DEFAULT_MODEL) ?? DEFAULT_MODEL;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(this.baseUrl, this.apiKey, options);
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const raw = await this.openAiCompatListModels(this.baseUrl, this.apiKey);
      const models = raw.map((m: WireModel): ModelInfo => this.toModelInfo(m));

      if (models.some((model) => model.id === this.defaultModel)) return models;

      return [this.toModelInfo({ id: this.defaultModel }), ...models];
    } catch {
      return [this.toModelInfo({ id: this.defaultModel })];
    }
  }

  private toModelInfo(model: WireModel): ModelInfo {
    const meta = KNOWN_MODELS[model.id] ?? DEFAULT_META;
    const info: ModelInfo = {
      id: model.id,
      name: model.id,
      contextWindow: meta.contextWindow,
      supportsTools: meta.supportsTools,
      supportsVision: meta.supportsVision,
      raw: model as Record<string, unknown>,
    };
    if (meta.maxOutputTokens !== undefined) info.maxOutputTokens = meta.maxOutputTokens;
    return info;
  }
}
