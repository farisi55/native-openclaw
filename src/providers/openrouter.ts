/**
 * providers/openrouter.ts
 * Adapter for OpenRouter — unified gateway to 200+ models.
 * API ref: https://openrouter.ai/docs/api-reference
 *
 * Required env vars:
 *   OPENROUTER_API_KEY
 *
 * Optional env vars:
 *   OPENROUTER_BASE_URL     (default: https://openrouter.ai/api/v1)
 *   OPENROUTER_SITE_URL     (HTTP-Referer header)
 *   OPENROUTER_SITE_NAME    (X-Title header)
 */

import { type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { BaseProvider, type WireModel } from './base';

interface OpenRouterModel extends WireModel {
  name?: string;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number };
  architecture?: { modality?: string };
  supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export class OpenRouterProvider extends BaseProvider {
  readonly id = 'openrouter';
  readonly displayName = 'OpenRouter';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly extraHeaders: Record<string, string>;

  constructor() {
    super();
    this.apiKey = getEnv('OPENROUTER_API_KEY');
    this.baseUrl = (
      getOptionalEnv('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1') ??
      'https://openrouter.ai/api/v1'
    ).replace(/\/$/, '');

    this.extraHeaders = {};
    const siteUrl = getOptionalEnv('OPENROUTER_SITE_URL');
    const siteName = getOptionalEnv('OPENROUTER_SITE_NAME');
    if (siteUrl) this.extraHeaders['HTTP-Referer'] = siteUrl;
    if (siteName) this.extraHeaders['X-Title'] = siteName;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(this.baseUrl, this.apiKey, options, this.extraHeaders);
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.fetchJson<OpenRouterModelsResponse>(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
    });

    return (data.data ?? []).map((m): ModelInfo => {
      const modality = m.architecture?.modality ?? '';
      const supportsTools =
        Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools');
      const supportsVision = modality.includes('image') || modality.includes('vision');
      const info: ModelInfo = {
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.context_length ?? 4096,
        supportsTools,
        supportsVision,
        raw: m as Record<string, unknown>,
      };
      if (m.top_provider?.max_completion_tokens !== undefined) {
        info.maxOutputTokens = m.top_provider.max_completion_tokens;
      }
      return info;
    });
  }
}
