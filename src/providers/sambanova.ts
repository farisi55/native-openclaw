/**
 * providers/sambanova.ts
 * Adapter for SambaNova Cloud — OpenAI-compatible API on SambaNova LPU hardware.
 * API ref: https://docs.sambanova.ai/cloud/api-reference
 *
 * Required env vars:
 *   SAMBANOVA_API_KEY
 *
 * Optional env vars:
 *   SAMBANOVA_BASE_URL      (default: https://api.sambanova.ai/v1)
 *   SAMBANOVA_DEFAULT_MODEL (default: Meta-Llama-3.1-70B-Instruct)
 */

import { type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { BaseProvider, type WireModel } from './base';

// ─── Static model catalogue ───────────────────────────────────────────────────

interface SambaNovaMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const KNOWN_MODELS: Record<string, SambaNovaMeta> = {
  'Meta-Llama-3.1-405B-Instruct': { contextWindow: 16_384,  maxOutputTokens: 16_384, supportsTools: true,  supportsVision: false },
  'Meta-Llama-3.1-70B-Instruct':  { contextWindow: 131_072, maxOutputTokens: 16_384, supportsTools: true,  supportsVision: false },
  'Meta-Llama-3.1-8B-Instruct':   { contextWindow: 16_384,  maxOutputTokens: 16_384, supportsTools: true,  supportsVision: false },
  'Meta-Llama-3.2-11B-Vision-Instruct': { contextWindow: 16_384, maxOutputTokens: 8_192, supportsTools: false, supportsVision: true },
  'Meta-Llama-3.2-90B-Vision-Instruct': { contextWindow: 16_384, maxOutputTokens: 8_192, supportsTools: false, supportsVision: true },
  'Meta-Llama-3.3-70B-Instruct':  { contextWindow: 131_072, maxOutputTokens: 16_384, supportsTools: true,  supportsVision: false },
  'Qwen2.5-72B-Instruct':         { contextWindow: 32_768,  maxOutputTokens: 8_192,  supportsTools: true,  supportsVision: false },
  'Qwen2.5-Coder-32B-Instruct':   { contextWindow: 32_768,  maxOutputTokens: 8_192,  supportsTools: true,  supportsVision: false },
  'DeepSeek-V3.1':                 { contextWindow: 65_536,  maxOutputTokens: 16_384, supportsTools: false, supportsVision: false },
  'DeepSeek-V3':                   { contextWindow: 65_536,  maxOutputTokens: 16_384, supportsTools: false, supportsVision: false },
  'DeepSeek-R1':                   { contextWindow: 32_768,  maxOutputTokens: 16_384, supportsTools: false, supportsVision: false },
  'DeepSeek-R1-Distill-Llama-70B':{ contextWindow: 32_768,  maxOutputTokens: 16_384, supportsTools: false, supportsVision: false },
  'Llama-4-Scout-17B-16E-Instruct':{ contextWindow: 131_072, maxOutputTokens: 16_384, supportsTools: true,  supportsVision: true },
  'Llama-4-Maverick-17B-128E-Instruct': { contextWindow: 524_288, maxOutputTokens: 16_384, supportsTools: true, supportsVision: true },
};

const DEFAULT_META: SambaNovaMeta = {
  contextWindow: 16_384,
  supportsTools: false,
  supportsVision: false,
};

// ─── Provider ─────────────────────────────────────────────────────────────────

export class SambaNovaProvider extends BaseProvider {
  readonly id = 'sambanova';
  readonly displayName = 'SambaNova';

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    super();
    this.apiKey = getEnv('SAMBANOVA_API_KEY');
    this.baseUrl = (
      getOptionalEnv('SAMBANOVA_BASE_URL', 'https://api.sambanova.ai/v1') ??
      'https://api.sambanova.ai/v1'
    ).replace(/\/$/, '');
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(this.baseUrl, this.apiKey, options);
  }

  async listModels(): Promise<ModelInfo[]> {
    // SambaNova models endpoint is /v1/models — OpenAI-compatible
    try {
      const raw = await this.openAiCompatListModels(this.baseUrl, this.apiKey);
      return raw.map((m: WireModel): ModelInfo => {
        const meta = KNOWN_MODELS[m.id] ?? DEFAULT_META;
        const info: ModelInfo = {
          id: m.id,
          name: m.id,
          contextWindow: meta.contextWindow,
          supportsTools: meta.supportsTools,
          supportsVision: meta.supportsVision,
          raw: m as Record<string, unknown>,
        };
        if (meta.maxOutputTokens !== undefined) info.maxOutputTokens = meta.maxOutputTokens;
        return info;
      });
    } catch {
      // Fall back to static catalogue if /models endpoint is unavailable
      return Object.entries(KNOWN_MODELS).map(([id, meta]): ModelInfo => {
        const info: ModelInfo = {
          id,
          name: id,
          contextWindow: meta.contextWindow,
          supportsTools: meta.supportsTools,
          supportsVision: meta.supportsVision,
        };
        if (meta.maxOutputTokens !== undefined) info.maxOutputTokens = meta.maxOutputTokens;
        return info;
      });
    }
  }
}
