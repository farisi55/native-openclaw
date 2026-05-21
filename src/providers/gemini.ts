/**
 * providers/gemini.ts
 * Adapter for Google Gemini (Generative Language API).
 * API ref: https://ai.google.dev/api/generate-content
 *
 * Required env vars:
 *   GEMINI_API_KEY
 *
 * Optional env vars:
 *   GEMINI_BASE_URL     (default: https://generativelanguage.googleapis.com/v1beta)
 *   GEMINI_DEFAULT_MODEL (default: gemini-1.5-flash)
 *
 * NOTE: Gemini uses a non-OpenAI wire format. This adapter translates
 * internal Message[] ↔ Gemini Contents[] without using the SDK.
 */

import { createMessage, extractText } from '../types/message';
import {
  ProviderError,
  type ChatOptions,
  type ChatResponse,
  type ModelInfo,
} from '../types/provider';
import { getEnv, getOptionalEnv } from '../config/env';
import { now } from '../utils/helpers';
import { BaseProvider } from './base';

// ─── Gemini wire types ────────────────────────────────────────────────────────

interface GeminiPart {
  text: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerateRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason?: string;
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
}

interface GeminiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GeminiModelsResponse {
  models: GeminiModel[];
}

// ─── Known model metadata ─────────────────────────────────────────────────────

interface GeminiMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsVision: boolean;
}

const KNOWN_MODELS: Record<string, GeminiMeta> = {
  'gemini-2.0-flash':          { contextWindow: 1_048_576, maxOutputTokens: 8_192,  supportsVision: true },
  'gemini-2.0-flash-lite':     { contextWindow: 1_048_576, maxOutputTokens: 8_192,  supportsVision: true },
  'gemini-1.5-flash':          { contextWindow: 1_048_576, maxOutputTokens: 8_192,  supportsVision: true },
  'gemini-1.5-flash-8b':       { contextWindow: 1_048_576, maxOutputTokens: 8_192,  supportsVision: true },
  'gemini-1.5-pro':            { contextWindow: 2_097_152, maxOutputTokens: 8_192,  supportsVision: true },
  'gemini-1.0-pro':            { contextWindow: 30_720,    maxOutputTokens: 2_048,   supportsVision: false },
};

const DEFAULT_META: GeminiMeta = { contextWindow: 32_768, supportsVision: false };

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini';

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    super();
    this.apiKey = getEnv('GEMINI_API_KEY');
    this.baseUrl = (
      getOptionalEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta') ??
      'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');
  }

  // ── Message mapping: internal → Gemini ──────────────────────────────────────

  private toGeminiContents(opts: ChatOptions): GeminiContent[] {
    const contents: GeminiContent[] = [];

    for (const msg of opts.messages) {
      if (msg.role === 'system') continue; // handled via systemInstruction

      const text = extractText(msg.content);
      // Gemini roles: 'user' | 'model' (no 'assistant')
      const role: GeminiContent['role'] =
        msg.role === 'assistant' ? 'model' : 'user';

      // Merge consecutive same-role messages (Gemini requires alternating)
      const last = contents[contents.length - 1];
      if (last && last.role === role) {
        last.parts.push({ text });
      } else {
        contents.push({ role, parts: [{ text }] });
      }
    }

    // Gemini requires conversation to start with a 'user' turn
    if (contents.length > 0 && contents[0]?.role !== 'user') {
      contents.unshift({ role: 'user', parts: [{ text: '' }] });
    }

    return contents;
  }

  // ── chat() ──────────────────────────────────────────────────────────────────

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const startedAt = now();

    // Gemini model names in the API must be bare (no "models/" prefix for this endpoint)
    const modelId = options.model.replace(/^models\//, '');
    const url = `${this.baseUrl}/models/${modelId}:generateContent?key=${this.apiKey}`;

    const body: GeminiGenerateRequest = {
      contents: this.toGeminiContents(options),
    };

    if (options.systemPrompt) {
      body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
    }

    body.generationConfig = {};
    if (options.temperature !== undefined) {
      body.generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      body.generationConfig.maxOutputTokens = options.maxTokens;
    }

    this.logger.debug('chat request', { provider: this.id, model: modelId });

    const data = await this.fetchJson<GeminiGenerateResponse>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new ProviderError(this.id, 'UNKNOWN', 'Gemini returned no candidates.');
    }

    const text = candidate.content?.parts?.map((p) => p.text).join('') ?? '';
    const message = createMessage({ role: 'assistant', content: text });
    const latencyMs = now() - startedAt;

    const usage = data.usageMetadata
      ? {
          promptTokens:     data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens:      data.usageMetadata.totalTokenCount ?? 0,
        }
      : undefined;

    this.logger.debug('chat response', { provider: this.id, model: modelId, latencyMs });

    return this.buildChatResponse({ message, model: modelId, latencyMs, usage, raw: data as unknown as Record<string, unknown> });
  }

  // ── listModels() ────────────────────────────────────────────────────────────

  async listModels(): Promise<ModelInfo[]> {
    const url = `${this.baseUrl}/models?key=${this.apiKey}`;

    let data: GeminiModelsResponse;
    try {
      data = await this.fetchJson<GeminiModelsResponse>(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      return [];
    }

    return (data.models ?? [])
      .filter((m) =>
        (m.supportedGenerationMethods ?? []).includes('generateContent')
      )
      .map((m): ModelInfo => {
        // Strip "models/" prefix for clean display
        const id = m.name.replace(/^models\//, '');
        const meta = KNOWN_MODELS[id] ?? DEFAULT_META;
        const info: ModelInfo = {
          id,
          name: m.displayName ?? id,
          contextWindow: m.inputTokenLimit ?? meta.contextWindow,
          supportsTools: false,
          supportsVision: meta.supportsVision,
          raw: m as unknown as Record<string, unknown>,
        };
        const maxOut = m.outputTokenLimit ?? meta.maxOutputTokens;
        if (maxOut !== undefined) info.maxOutputTokens = maxOut;
        return info;
      });
  }

  // ── healthCheck() ────────────────────────────────────────────────────────────

  override async healthCheck(): Promise<boolean> {
    try {
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }
}
