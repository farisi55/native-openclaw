/**
 * providers/puter.ts
 * Adapter for Puter.ai when an HTTP/OpenAI-compatible backend endpoint is configured.
 *
 * Puter.js browser calls are intentionally not used here; Web UI requests must
 * stay inside the backend orchestrator/tool-loop path.
 *
 * Required env vars when PUTER_ENABLED=true:
 *   PUTER_API_KEY
 *   PUTER_BASE_URL
 *
 * Optional env vars:
 *   PUTER_DEFAULT_MODEL  (default: gpt-5.5)
 *   PUTER_DISABLE_TEMPERATURE  (default: true)
 *   PUTER_TEMPERATURE
 *   PUTER_REASONING_MODELS_DISABLE_TEMPERATURE  (default: true)
 */

import { ProviderError, type ChatOptions, type ChatResponse, type ModelInfo } from '../types/provider';
import { getEnvBool, getOptionalEnv } from '../config/env';
import {
  BaseProvider,
  type WireChatRequest,
  type WireChatResponse,
  type WireModel,
} from './base';
import { now } from '../utils/helpers';
import { createLogger } from '../utils/logger';

interface PuterModelMeta {
  contextWindow: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_META: PuterModelMeta = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  supportsTools: false,
  supportsVision: false,
};

const puterLogger = createLogger('provider:puter');

export function shouldOmitTemperatureForPuter(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  const modelName = normalized.split('/').at(-1) ?? normalized;
  if (!modelName) return true;
  if (modelName.startsWith('gpt-5')) return true;

  return [
    /\bo[1-9](?:-|$)/,
    /\breasoning\b/,
    /\bdeepseek-r1\b/,
    /\br1(?:-|$)/,
    /\bqwq\b/,
  ].some((pattern) => pattern.test(modelName));
}

function parseOptionalTemperature(): number | undefined {
  const raw = getOptionalEnv('PUTER_TEMPERATURE')?.trim();
  if (!raw) return undefined;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isTemperatureUnsupportedError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('temperature') &&
    (
      message.includes('unsupported value') ||
      message.includes('does not support') ||
      message.includes('unsupported')
    )
  );
}

export class PuterProvider extends BaseProvider {
  readonly id = 'puter';
  readonly displayName = 'Puter.ai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor() {
    super();
    this.apiKey = getOptionalEnv('PUTER_API_KEY')?.trim() ?? '';
    this.baseUrl = (getOptionalEnv('PUTER_BASE_URL')?.trim() ?? '').replace(/\/$/, '');
    this.defaultModel = getOptionalEnv('PUTER_DEFAULT_MODEL', DEFAULT_MODEL)?.trim() || DEFAULT_MODEL;

    if (!this.apiKey || !this.baseUrl) {
      throw new Error(
        'Puter backend provider requires PUTER_API_KEY and PUTER_BASE_URL. ' +
        'Direct frontend Puter.js final-answer mode is not supported because it bypasses tools.'
      );
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const body = this.buildPuterChatRequest(options);

    try {
      return await this.sendPuterChatRequest(body, options);
    } catch (err) {
      if (!('temperature' in body) || !isTemperatureUnsupportedError(err)) throw err;

      puterLogger.warn('puter temperature unsupported, retrying without temperature', {
        model: options.model,
      });

      const retryBody: WireChatRequest = { ...body };
      delete retryBody.temperature;
      return this.sendPuterChatRequest(retryBody, options);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const raw = await this.openAiCompatListModels(this.baseUrl, this.apiKey);
      const models = raw.map((model) => this.toModelInfo(model));
      if (models.some((model) => model.id === this.defaultModel)) return models;
      return [this.toModelInfo({ id: this.defaultModel }), ...models];
    } catch {
      return [this.toModelInfo({ id: this.defaultModel })];
    }
  }

  private toModelInfo(model: WireModel): ModelInfo {
    const info: ModelInfo = {
      id: model.id,
      name: model.id,
      contextWindow: DEFAULT_META.contextWindow,
      supportsTools: DEFAULT_META.supportsTools,
      supportsVision: DEFAULT_META.supportsVision,
      raw: model as Record<string, unknown>,
    };
    if (DEFAULT_META.maxOutputTokens !== undefined) info.maxOutputTokens = DEFAULT_META.maxOutputTokens;
    return info;
  }

  private buildPuterChatRequest(options: ChatOptions): WireChatRequest {
    const extra = { ...(options.extra ?? {}) };
    const temperature = this.resolveTemperature(options.model);
    if (temperature === undefined) delete extra['temperature'];

    const body: WireChatRequest = {
      model: options.model,
      messages: this.toWireMessages(options.messages, options.systemPrompt),
      stream: false,
      ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
      ...extra,
    };

    if (temperature !== undefined) body.temperature = temperature;
    return body;
  }

  private resolveTemperature(model: string): number | undefined {
    if (getEnvBool('PUTER_DISABLE_TEMPERATURE', true)) {
      puterLogger.debug('omitting temperature for model', {
        model,
        reason: 'PUTER_DISABLE_TEMPERATURE',
      });
      return undefined;
    }

    const configured = parseOptionalTemperature();
    if (configured === undefined) {
      puterLogger.debug('omitting temperature for model', {
        model,
        reason: 'PUTER_TEMPERATURE empty or invalid',
      });
      return undefined;
    }

    if (
      getEnvBool('PUTER_REASONING_MODELS_DISABLE_TEMPERATURE', true) &&
      shouldOmitTemperatureForPuter(model)
    ) {
      puterLogger.debug('omitting temperature for model', {
        model,
        reason: 'model does not support temperature',
      });
      return undefined;
    }

    return configured;
  }

  private async sendPuterChatRequest(
    body: WireChatRequest,
    options: ChatOptions
  ): Promise<ChatResponse> {
    const startedAt = now();
    puterLogger.debug('chat request', {
      provider: this.id,
      model: body.model,
      messageCount: body.messages.length,
      hasTemperature: 'temperature' in body,
    });

    const data = await this.fetchJson<WireChatResponse>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    const choice = data.choices[0];
    if (!choice) throw new ProviderError(this.id, 'UNKNOWN', 'API returned no choices.');

    return this.buildChatResponse({
      message: this.fromWireMessage(choice.message),
      model: data.model ?? body.model,
      latencyMs: now() - startedAt,
      usage: this.normaliseUsage(data.usage),
      raw: data as Record<string, unknown>,
    });
  }
}
