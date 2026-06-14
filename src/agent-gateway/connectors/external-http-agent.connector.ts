import { redactSecrets } from '../../self-healing/log-redactor';
import { createLogger } from '../../utils/logger';
import type {
  AgentCapability,
  AgentConnector,
  AgentExecutionResult,
  AgentHealthResult,
  AgentRiskLevel,
  AgentTask,
} from '../agent-gateway.types';

const logger = createLogger('agent:external-http');
const MAX_RESPONSE_CHARS = 1_000_000;
const SECRET_KEY = /(?:api.?key|token|secret|password|authorization|cookie|credential|private.?key|^env$|process\.env)/i;

export interface ExternalHttpAgentConfig {
  id: string;
  displayName: string;
  enabled: boolean;
  baseUrl: string;
  endpoint?: string;
  capabilities: readonly AgentCapability[];
  timeoutMs?: number;
  healthTimeoutMs?: number;
  apiKeyEnv?: string;
  riskLevel?: AgentRiskLevel;
  priority?: number;
  profile?: string;
}

export type ExternalAgentFetch = typeof fetch;

function sanitizedExternalValue(
  value: unknown,
  seen = new WeakSet<object>()
): unknown {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizedExternalValue(item, seen));
  }
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  const record = value as Record<string, unknown>;
  const protectedPath = Object.entries(record).some(
    ([key, item]) =>
      /(?:^|file|source|target)path$|^(?:file|source)$/i.test(key) &&
      typeof item === 'string' &&
      /(?:^|[\\/])\.env(?:[./\\]|$)|\.(?:pem|key)$|(?:^|[\\/])id_rsa$/i.test(item)
  );
  if (protectedPath) return { omitted: 'protected file context' };

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (SECRET_KEY.test(key)) continue;
    const sanitized = sanitizedExternalValue(item, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(endpoint.replace(/^\/+/, ''), normalizedBase).toString();
}

function errorResult(
  task: AgentTask,
  agentId: string,
  code: string,
  message: string
): AgentExecutionResult {
  return {
    ok: false,
    agentId,
    capability: task.capability,
    summary: message,
    error: { code, message },
  };
}

export class ExternalHttpAgentConnector implements AgentConnector {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly AgentCapability[];
  readonly riskLevel: AgentRiskLevel;
  readonly priority: number;
  readonly profile?: string;

  constructor(
    readonly config: ExternalHttpAgentConfig,
    private readonly fetchFn: ExternalAgentFetch = fetch
  ) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.capabilities = config.capabilities;
    this.riskLevel = config.riskLevel ?? 'warning';
    this.priority = config.priority ?? 100;
    if (config.profile) this.profile = config.profile;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  canHandle(task: AgentTask): boolean {
    return this.capabilities.includes(task.capability);
  }

  async execute(
    task: AgentTask,
    signal?: AbortSignal
  ): Promise<AgentExecutionResult> {
    if (!this.isEnabled()) {
      return errorResult(
        task,
        this.id,
        'EXTERNAL_AGENT_DISABLED',
        `External agent ${this.id} is disabled.`
      );
    }

    let url: string;
    try {
      url = endpointUrl(this.config.baseUrl, this.config.endpoint ?? '/agent/run');
    } catch {
      return errorResult(
        task,
        this.id,
        'EXTERNAL_AGENT_CONFIG_INVALID',
        `External agent ${this.id} has an invalid base URL.`
      );
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      task.constraints?.maxRuntimeMs ??
        this.config.timeoutMs ??
        300_000
    );
    let timeoutReached = false;
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timeoutReached = true;
      controller.abort();
    }, timeoutMs);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    const apiKey = this.config.apiKeyEnv
      ? process.env[this.config.apiKeyEnv]?.trim()
      : undefined;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;

    const payload = {
      taskId: task.id,
      capability: task.capability,
      input: redactSecrets(task.userInput),
      context: sanitizedExternalValue(task.context ?? {}),
      constraints: sanitizedExternalValue(task.constraints ?? {}),
    };

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (rawText.length > MAX_RESPONSE_CHARS) {
        return errorResult(
          task,
          this.id,
          'EXTERNAL_AGENT_RESPONSE_TOO_LARGE',
          `External agent ${this.id} returned a response larger than ${MAX_RESPONSE_CHARS} characters.`
        );
      }

      let body: unknown;
      try {
        body = rawText ? JSON.parse(rawText) : null;
      } catch {
        return errorResult(
          task,
          this.id,
          'EXTERNAL_AGENT_INVALID_RESPONSE',
          `External agent ${this.id} returned invalid JSON.`
        );
      }
      if (!response.ok) {
        const record = body && typeof body === 'object'
          ? body as Record<string, unknown>
          : {};
        const nestedError = record['error'];
        const nestedCode =
          nestedError && typeof nestedError === 'object' &&
          typeof (nestedError as Record<string, unknown>)['code'] === 'string'
            ? String((nestedError as Record<string, unknown>)['code'])
            : undefined;
        const message =
          nestedError && typeof nestedError === 'object' &&
          typeof (nestedError as Record<string, unknown>)['message'] === 'string'
            ? String((nestedError as Record<string, unknown>)['message'])
            : `External agent ${this.id} returned HTTP ${response.status}.`;
        return errorResult(
          task,
          this.id,
          nestedCode ??
            (response.status >= 500
              ? 'EXTERNAL_AGENT_UNAVAILABLE'
              : 'EXTERNAL_AGENT_REQUEST_FAILED'),
          redactSecrets(message)
        );
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return errorResult(
          task,
          this.id,
          'EXTERNAL_AGENT_INVALID_RESPONSE',
          `External agent ${this.id} returned an invalid response object.`
        );
      }

      const record = body as Record<string, unknown>;
      if (
        typeof record['ok'] !== 'boolean' ||
        typeof record['summary'] !== 'string'
      ) {
        return errorResult(
          task,
          this.id,
          'EXTERNAL_AGENT_INVALID_RESPONSE',
          `External agent ${this.id} response is missing ok or summary.`
        );
      }
      const externalError = record['error'];
      const normalized: AgentExecutionResult = {
        ok: record['ok'],
        agentId: this.id,
        capability: task.capability,
        summary: redactSecrets(record['summary']),
        ...(typeof record['output'] === 'string'
          ? { output: redactSecrets(record['output']) }
          : {}),
        ...(Array.isArray(record['artifacts'])
          ? {
              artifacts: record['artifacts'].filter(
                (item): item is string => typeof item === 'string'
              ),
            }
          : {}),
        ...(record['metadata'] &&
        typeof record['metadata'] === 'object' &&
        !Array.isArray(record['metadata'])
          ? {
              metadata: sanitizedExternalValue(record['metadata']) as Record<
                string,
                unknown
              >,
            }
          : {}),
      };
      if (!normalized.ok) {
        const errorRecord =
          externalError &&
          typeof externalError === 'object' &&
          !Array.isArray(externalError)
            ? externalError as Record<string, unknown>
            : {};
        normalized.error = {
          code:
            typeof errorRecord['code'] === 'string'
              ? errorRecord['code']
              : 'EXTERNAL_AGENT_FAILED',
          message:
            typeof errorRecord['message'] === 'string'
              ? redactSecrets(errorRecord['message'])
              : normalized.summary,
        };
      }
      return normalized;
    } catch (error) {
      const aborted = controller.signal.aborted;
      if (timeoutReached) {
        return errorResult(
          task,
          this.id,
          'AGENT_TIMEOUT',
          `Agent execution timed out after ${timeoutMs}ms.`
        );
      }
      if (aborted) {
        return errorResult(
          task,
          this.id,
          'AGENT_ABORTED',
          `External agent ${this.id} request was aborted.`
        );
      }
      logger.warn('external agent unavailable', {
        agentId: this.id,
        capability: task.capability,
        error: error instanceof Error ? error.message : String(error),
      });
      return errorResult(
        task,
        this.id,
        'EXTERNAL_AGENT_UNAVAILABLE',
        `External agent ${this.id} is unavailable.`
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async healthCheck(): Promise<AgentHealthResult> {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1, this.config.healthTimeoutMs ?? 3000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchFn(
        endpointUrl(this.config.baseUrl, '/health'),
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        }
      );
      return {
        ok: response.ok,
        message: response.ok
          ? 'healthy'
          : `health endpoint returned HTTP ${response.status}`,
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        ok: false,
        message: 'unavailable',
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
