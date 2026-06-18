import type { IProvider, ModelInfo } from '../../types/provider';

export type ModelSource = 'configured' | 'discovered' | 'custom' | 'curated';

export type ProviderModelStatus =
  | 'available'
  | 'unknown'
  | 'unavailable'
  | 'tested-ok'
  | 'tested-failed';

export interface ProviderModelInfo {
  id: string;
  providerId: string;
  displayName?: string;
  source: ModelSource;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsStreaming?: boolean;
  supportsJsonMode?: boolean;
  inputModalities?: string[];
  outputModalities?: string[];
  rateLimits?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  freeTierLikely?: boolean;
  status?: ProviderModelStatus;
  lastDiscoveredAt?: string;
  lastTestedAt?: string;
  lastError?: string;
  raw?: unknown;
}

export interface ProviderModelCacheEntry {
  updatedAt?: string;
  models: ProviderModelInfo[];
  lastError?: ProviderModelDiscoveryErrorInfo;
}

export interface ProviderModelCacheDocument {
  version: 1;
  updatedAt: string;
  providers: Record<string, ProviderModelCacheEntry>;
  custom: Record<string, ProviderModelInfo[]>;
}

export type ProviderModelDiscoveryErrorCode =
  | 'DISCOVERY_AUTH_ERROR'
  | 'DISCOVERY_RATE_LIMIT'
  | 'DISCOVERY_TIMEOUT'
  | 'DISCOVERY_UNSUPPORTED'
  | 'DISCOVERY_INVALID_RESPONSE'
  | 'DISCOVERY_NETWORK_ERROR';

export interface ProviderModelDiscoveryErrorInfo {
  providerId: string;
  ok: false;
  code: ProviderModelDiscoveryErrorCode;
  message: string;
  retryable: boolean;
}

export interface ProviderModelDiscoveryResult {
  providerId: string;
  ok: boolean;
  models: ProviderModelInfo[];
  error?: ProviderModelDiscoveryErrorInfo;
  skipped?: boolean;
}

export interface ProviderModelDiscoveryAdapter {
  providerId: string;
  isEnabled(): boolean;
  disabledReason?(): string | null;
  refresh(signal?: AbortSignal): Promise<ProviderModelInfo[]>;
}

export interface ProviderModelRegistryFilter {
  providerId?: string;
  source?: ModelSource;
  search?: string;
  limit?: number;
  testedOnly?: boolean;
}

export interface ProviderModelRegistrySource {
  providers: Map<string, IProvider>;
  configuredModels(provider: IProvider): Promise<ModelInfo[]>;
}

export class ModelDiscoveryError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly code: ProviderModelDiscoveryErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }

  toInfo(): ProviderModelDiscoveryErrorInfo {
    return {
      providerId: this.providerId,
      ok: false,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

