/**
 * providers/mistral.ts
 * Adapter for Mistral AI.
 * API ref: https://docs.mistral.ai/api/
 *
 * Required env vars:
 *   MISTRAL_API_KEY
 *
 * Optional env vars:
 *   MISTRAL_BASE_URL  (default: https://api.mistral.ai/v1)
 */

import { type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { BaseProvider, type WireModel } from './base';

interface MistralModel extends WireModel {
  name?: string;
  max_context_length?: number;
  capabilities?: {
    completion_chat?: boolean;
    function_calling?: boolean;
    vision?: boolean;
  };
  deprecation?: string | null;
}

interface MistralModelsResponse {
  data: MistralModel[];
}

interface MistralMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const KNOWN_MODELS: Record<string, MistralMeta> = {
  'mistral-large-latest':  { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: false },
  'mistral-medium-latest': { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: false },
  'mistral-small-latest':  { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: false },
  'mistral-nemo':          { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: false },
  'codestral-latest':      { contextWindow: 256_000, maxOutputTokens: 8_192, supportsTools: true,  supportsVision: false },
  'pixtral-large-latest':  { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: true  },
  'pixtral-12b-2409':      { contextWindow: 131_072, maxOutputTokens: 4_096, supportsTools: true,  supportsVision: true  },
  'open-mistral-7b':       { contextWindow: 32_768,  supportsTools: false, supportsVision: false },
  'open-mixtral-8x7b':     { contextWindow: 32_768,  supportsTools: false, supportsVision: false },
  'open-mixtral-8x22b':    { contextWindow: 65_536,  supportsTools: true,  supportsVision: false },
};

const DEFAULT_META: MistralMeta = { contextWindow: 32_768, supportsTools: false, supportsVision: false };

export class MistralProvider extends BaseProvider {
  readonly id = 'mistral';
  readonly displayName = 'Mistral AI';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly acceptHeader: Record<string, string> = { Accept: 'application/json' };

  constructor() {
    super();
    this.apiKey = getEnv('MISTRAL_API_KEY');
    this.baseUrl = (
      getOptionalEnv('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1') ??
      'https://api.mistral.ai/v1'
    ).replace(/\/$/, '');
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(this.baseUrl, this.apiKey, options, this.acceptHeader);
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.fetchJson<MistralModelsResponse>(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...this.acceptHeader },
    });

    return (data.data ?? [])
      .filter((m) => !m.deprecation)
      .map((m): ModelInfo => {
        const staticMeta = KNOWN_MODELS[m.id] ?? DEFAULT_META;
        const info: ModelInfo = {
          id: m.id,
          name: m.name ?? m.id,
          contextWindow: m.max_context_length ?? staticMeta.contextWindow,
          supportsTools: m.capabilities?.function_calling ?? staticMeta.supportsTools,
          supportsVision: m.capabilities?.vision ?? staticMeta.supportsVision,
          raw: m as Record<string, unknown>,
        };
        if (staticMeta.maxOutputTokens !== undefined) info.maxOutputTokens = staticMeta.maxOutputTokens;
        return info;
      });
  }
}
