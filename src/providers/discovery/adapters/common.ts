import { networkFetch } from '../../../network';
import {
  ModelDiscoveryError,
  type ProviderModelDiscoveryErrorCode,
} from '../model-discovery.types';

export function splitCsv(value: string | undefined, fallback: string[]): string[] {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : fallback;
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function envEnabled(value: string | undefined, fallback: boolean): boolean {
  const raw = value ?? String(fallback);
  return ['true', '1', 'yes'].includes(raw.trim().toLowerCase());
}

export function safeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

export function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function statusToCode(status: number): ProviderModelDiscoveryErrorCode {
  if (status === 401 || status === 403 || status === 498) return 'DISCOVERY_AUTH_ERROR';
  if (status === 408 || status === 499 || status === 504) return 'DISCOVERY_TIMEOUT';
  if (status === 429) return 'DISCOVERY_RATE_LIMIT';
  if (status === 404 || status === 501) return 'DISCOVERY_UNSUPPORTED';
  return status >= 500 ? 'DISCOVERY_NETWORK_ERROR' : 'DISCOVERY_INVALID_RESPONSE';
}

function retryable(code: ProviderModelDiscoveryErrorCode): boolean {
  return code === 'DISCOVERY_RATE_LIMIT' ||
    code === 'DISCOVERY_TIMEOUT' ||
    code === 'DISCOVERY_NETWORK_ERROR';
}

export async function fetchJsonForDiscovery<T>(
  providerId: string,
  url: string,
  options: {
    headers?: Record<string, string>;
    signal?: AbortSignal;
    timeoutMs: number;
  }
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const signal = options.signal
    ? combineSignals(options.signal, controller.signal)
    : controller.signal;

  try {
    const init: RequestInit = {
      method: 'GET',
      signal,
    };
    if (options.headers) init.headers = options.headers;
    const response = await networkFetch(url, init);
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { body = ''; }
      const code = statusToCode(response.status);
      throw new ModelDiscoveryError(
        providerId,
        code,
        `Discovery request failed with HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`,
        retryable(code)
      );
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof ModelDiscoveryError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelDiscoveryError(providerId, 'DISCOVERY_TIMEOUT', 'Discovery request timed out.', true, error);
    }
    throw new ModelDiscoveryError(
      providerId,
      'DISCOVERY_NETWORK_ERROR',
      error instanceof Error ? error.message : String(error),
      true,
      error
    );
  } finally {
    clearTimeout(timer);
  }
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
  }
  for (const signal of signals) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

