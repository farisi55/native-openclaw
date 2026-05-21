/**
 * providers/groq.ts
 * Adapter for Groq — high-throughput LPU inference.
 * API ref: https://console.groq.com/docs/openai
 *
 * Required env vars:
 *   GROQ_API_KEY
 *
 * Optional env vars:
 *   GROQ_BASE_URL  (default: https://api.groq.com/openai/v1)
 */

import { type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { BaseProvider, type WireModel } from './base';

interface GroqModelMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const KNOWN_MODELS: Record<string, GroqModelMeta> = {
  'llama-3.3-70b-versatile':       { contextWindow: 128_000, maxOutputTokens: 32_768, supportsTools: true,  supportsVision: false },
  'llama-3.1-8b-instant':          { contextWindow: 128_000, maxOutputTokens: 8_192,  supportsTools: true,  supportsVision: false },
  'llama-3.2-11b-vision-preview':  { contextWindow: 128_000, maxOutputTokens: 8_192,  supportsTools: false, supportsVision: true  },
  'llama-3.2-90b-vision-preview':  { contextWindow: 128_000, maxOutputTokens: 8_192,  supportsTools: false, supportsVision: true  },
  'mixtral-8x7b-32768':            { contextWindow: 32_768,  maxOutputTokens: 32_768, supportsTools: true,  supportsVision: false },
  'gemma2-9b-it':                  { contextWindow: 8_192,   maxOutputTokens: 8_192,  supportsTools: true,  supportsVision: false },
  'deepseek-r1-distill-llama-70b': { contextWindow: 128_000, maxOutputTokens: 16_000, supportsTools: false, supportsVision: false },
};

const DEFAULT_META: GroqModelMeta = { contextWindow: 8_192, supportsTools: false, supportsVision: false };

export class GroqProvider extends BaseProvider {
  readonly id = 'groq';
  readonly displayName = 'Groq';

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    super();
    this.apiKey = getEnv('GROQ_API_KEY');
    this.baseUrl = (
      getOptionalEnv('GROQ_BASE_URL', 'https://api.groq.com/openai/v1') ??
      'https://api.groq.com/openai/v1'
    ).replace(/\/$/, '');
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(this.baseUrl, this.apiKey, options);
  }

  async listModels(): Promise<ModelInfo[]> {
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
      return [];
    }
  }
}
