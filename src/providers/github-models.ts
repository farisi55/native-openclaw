/**
 * GitHub Models provider.
 * Uses the GitHub Models OpenAI-compatible chat completions endpoint.
 */

import { getEnv, getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import type { ChatOptions, ChatResponse, ModelInfo } from '../types/provider';
import { createMessage } from '../types/message';
import { BaseProvider } from './base';
import { parseProviderModels } from './provider-env';

const DEFAULT_BASE_URL = 'https://models.github.ai/inference';
const DEFAULT_MODEL = 'openai/gpt-4.1';
const DEFAULT_API_VERSION = '2026-03-10';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveTimeout(key: string, fallback: number): number {
  const timeout = getEnvInt(key, fallback);
  if (timeout <= 0) throw new Error(`[env] Env var "${key}" must be a positive integer.`);
  return timeout;
}

export class GitHubModelsProvider extends BaseProvider {
  readonly id = 'github-models';
  readonly displayName = 'GitHub Models';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly models: string[];
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor() {
    super();
    this.apiKey = getEnv('GITHUB_MODELS_API_KEY').trim();
    if (!this.apiKey) throw new Error('[env] GITHUB_MODELS_API_KEY must not be empty.');
    this.defaultModel =
      nonEmpty(getOptionalEnv('GITHUB_MODELS_DEFAULT_MODEL')) ?? DEFAULT_MODEL;
    this.models = parseProviderModels(
      nonEmpty(getOptionalEnv('GITHUB_MODELS_MODELS')),
      this.defaultModel
    );
    this.apiVersion =
      nonEmpty(getOptionalEnv('GITHUB_MODELS_API_VERSION')) ?? DEFAULT_API_VERSION;
    this.timeoutMs = positiveTimeout('GITHUB_MODELS_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);

    const useOrgEndpoint = getEnvBool('GITHUB_MODELS_USE_ORG_ENDPOINT', false);
    if (useOrgEndpoint) {
      const org = nonEmpty(getOptionalEnv('GITHUB_MODELS_ORG'));
      if (!org) {
        throw new Error(
          '[env] GITHUB_MODELS_ORG is required when GITHUB_MODELS_USE_ORG_ENDPOINT=true.'
        );
      }
      this.baseUrl = `https://models.github.ai/orgs/${encodeURIComponent(org)}/inference`;
    } else {
      this.baseUrl = (
        nonEmpty(getOptionalEnv('GITHUB_MODELS_BASE_URL')) ?? DEFAULT_BASE_URL
      ).replace(/\/$/, '');
    }

    this.headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.apiVersion,
    };
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.openAiCompatChat(
      this.baseUrl,
      this.apiKey,
      options,
      this.headers,
      this.timeoutMs
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((id): ModelInfo => ({
      id,
      name: id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsVision: id.toLowerCase().includes('vision'),
    }));
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
    if (status === 401) return 'GitHub Models authentication failed.';
    if (status === 403) {
      return 'GitHub Models permission denied. Ensure the token has Models read access.';
    }
    if (status === 404) return 'GitHub Models endpoint or model was not found.';
    if (status === 408) return 'GitHub Models request timed out.';
    if (status === 413) return 'GitHub Models request was too large.';
    if (status === 429) return 'GitHub Models rate limit exceeded.';
    if (status >= 500) return 'GitHub Models is temporarily unavailable.';
    return `GitHub Models request failed with HTTP ${status}.`;
  }
}
