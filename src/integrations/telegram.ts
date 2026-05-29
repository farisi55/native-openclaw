import { getEnvBool, getEnvInt, getOptionalEnv } from '../config';
import type { ApiDependencies, ApiRuntimeState } from '../api';
import { createApiRuntimeState, handleChatRoute } from '../api';
import { TelegramSessionManager } from '../storage';
import { createLogger } from '../utils/logger';
import { networkFetch } from '../network';

const logger = createLogger('telegram');
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TELEGRAM_MESSAGE = 4000;

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  allowedChatIds: Set<string>;
  allowAll: boolean;
  ackEnabled?: boolean;
  ackMessage?: string;
  processTimeoutMs?: number;
  logPollingErrors?: boolean;
  retryMinMs?: number;
  retryMaxMs?: number;
  pollTimeoutSeconds?: number;
  queueNoticeEnabled?: boolean;
}

interface TelegramRuntimeOptions {
  ackEnabled: boolean;
  ackMessage: string;
  processTimeoutMs: number;
  logPollingErrors: boolean;
  retryMinMs: number;
  retryMaxMs: number;
  pollTimeoutSeconds: number;
  queueNoticeEnabled: boolean;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
    };
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

class TelegramProcessingTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramProcessingTimeoutError';
  }
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveRuntimeOptions(cfg: TelegramConfig): TelegramRuntimeOptions {
  const retryMinMs = positiveInt(
    cfg.retryMinMs ?? getEnvInt('TELEGRAM_RETRY_MIN_MS', 3_000),
    3_000
  );

  return {
    ackEnabled: cfg.ackEnabled ?? getEnvBool('TELEGRAM_ACK_ENABLED', true),
    ackMessage: cfg.ackMessage ?? getOptionalEnv('TELEGRAM_ACK_MESSAGE', 'Sedang diproses...') ?? 'Sedang diproses...',
    processTimeoutMs: positiveInt(
      cfg.processTimeoutMs ?? getEnvInt('TELEGRAM_PROCESS_TIMEOUT_MS', 90_000),
      90_000
    ),
    logPollingErrors: cfg.logPollingErrors ?? getEnvBool('TELEGRAM_LOG_POLLING_ERRORS', false),
    retryMinMs,
    retryMaxMs: Math.max(
      retryMinMs,
      positiveInt(cfg.retryMaxMs ?? getEnvInt('TELEGRAM_RETRY_MAX_MS', 60_000), 60_000)
    ),
    pollTimeoutSeconds: positiveInt(
      cfg.pollTimeoutSeconds ?? getEnvInt('TELEGRAM_POLL_TIMEOUT', 25),
      25
    ),
    queueNoticeEnabled: cfg.queueNoticeEnabled ?? getEnvBool('TELEGRAM_QUEUE_NOTICE_ENABLED', false),
  };
}

export function loadTelegramConfig(): TelegramConfig {
  const token = getOptionalEnv('TELEGRAM_BOT_TOKEN');
  const allowedRaw = getOptionalEnv('TELEGRAM_ALLOWED_CHAT_IDS', '') ?? '';
  const allowedChatIds = new Set(
    allowedRaw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );

  const cfg: TelegramConfig = {
    enabled: getEnvBool('TELEGRAM_ENABLED', false),
    allowedChatIds,
    allowAll: getEnvBool('TELEGRAM_ALLOW_ALL', false),
    ackEnabled: getEnvBool('TELEGRAM_ACK_ENABLED', true),
    ackMessage: getOptionalEnv('TELEGRAM_ACK_MESSAGE', 'Sedang diproses...') ?? 'Sedang diproses...',
    processTimeoutMs: getEnvInt('TELEGRAM_PROCESS_TIMEOUT_MS', 90_000),
    logPollingErrors: getEnvBool('TELEGRAM_LOG_POLLING_ERRORS', false),
    retryMinMs: getEnvInt('TELEGRAM_RETRY_MIN_MS', 3_000),
    retryMaxMs: getEnvInt('TELEGRAM_RETRY_MAX_MS', 60_000),
    pollTimeoutSeconds: getEnvInt('TELEGRAM_POLL_TIMEOUT', 25),
    queueNoticeEnabled: getEnvBool('TELEGRAM_QUEUE_NOTICE_ENABLED', false),
  };
  if (token) cfg.botToken = token;
  return cfg;
}

export class TelegramIntegration {
  private offset = 0;
  private stopped = true;
  private baseStatePromise: Promise<ApiRuntimeState> | null = null;
  private readonly telegramSessions: TelegramSessionManager;
  private readonly runtime: TelegramRuntimeOptions;
  private readonly chatQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: ApiDependencies,
    private readonly cfg: TelegramConfig,
    dataDir: string
  ) {
    this.telegramSessions = new TelegramSessionManager(dataDir);
    this.runtime = resolveRuntimeOptions(cfg);
  }

  async start(): Promise<void> {
    if (!this.cfg.botToken) {
      logger.warn('Telegram enabled but TELEGRAM_BOT_TOKEN is missing; integration not started.');
      return;
    }

    if (this.cfg.allowedChatIds.size === 0 && !this.cfg.allowAll) {
      logger.warn(
        'Telegram enabled but TELEGRAM_ALLOWED_CHAT_IDS is empty. Set TELEGRAM_ALLOW_ALL=true to allow all chats.'
      );
      return;
    }

    if (this.cfg.allowedChatIds.size === 0 && this.cfg.allowAll) {
      logger.warn('Telegram TELEGRAM_ALLOW_ALL=true; all chats are allowed.');
    }

    await this.getBaseState();
    this.stopped = false;
    void this.pollLoop().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Telegram polling stopped unexpectedly', { error: msg });
    });
    logger.info('Telegram integration started');
  }

  stop(): void {
    this.stopped = true;
  }

  async notifyAllActive(message: string): Promise<void> {
    const chatIds = await this.telegramSessions.getAllChatIds();
    const sends = chatIds.map((chatId) =>
      this.sendText(chatId, message).catch((err: unknown) => {
        logger.debug('notify: sendText failed', {
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
    await Promise.allSettled(sends);
  }

  async handleIncomingText(chatId: string, text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!this.isAllowed(chatId)) return false;

    await this.sendChatAction(chatId);
    if (this.runtime.ackEnabled) {
      await this.sendText(chatId, this.runtime.ackMessage);
    }

    const baseState = await this.getBaseState();

    const sessionId = await this.ensureChatSession(chatId);
    const state: ApiRuntimeState = {
      activeProvider: baseState.activeProvider,
      activeModel: baseState.activeModel,
      activeSessionId: sessionId,
    };

    let response: Awaited<ReturnType<typeof handleChatRoute>>;
    try {
      response = await this.withTelegramTimeout(
        (signal) => handleChatRoute(
          { message: trimmed, sessionId: state.activeSessionId ?? undefined },
          this.deps,
          state,
          { signal }
        ),
        this.runtime.processTimeoutMs,
        'Proses terlalu lama atau provider sedang lambat. Silakan coba lagi sebentar lagi.'
      );
    } catch (err) {
      if (err instanceof TelegramProcessingTimeoutError) {
        logger.warn('Telegram message handling timed out', {
          chatId,
          timeoutMs: this.runtime.processTimeoutMs,
        });
        await this.sendText(chatId, err.message);
        return true;
      }
      throw err;
    }

    if (response.body.sessionId) {
      await this.telegramSessions.setSessionId(chatId, response.body.sessionId);
    }

    const reply = response.body.error_detail.length > 0
      ? `Error: ${response.body.error_detail.join('; ')}`
      : response.body.result ?? '';

    await this.sendText(chatId, reply || '(empty response)');
    return true;
  }

  private enqueueChatMessage(chatId: string, text: string): void {
    if (!this.isAllowed(chatId)) return;

    if (this.runtime.queueNoticeEnabled && this.chatQueues.has(chatId)) {
      void this.sendText(chatId, 'Pesan diterima. Masih memproses pesan sebelumnya...');
    }

    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    let next: Promise<void>;

    next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.handleIncomingText(chatId, text);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Telegram message handling error', { chatId, error: msg });
      })
      .finally(() => {
        if (this.chatQueues.get(chatId) === next) {
          this.chatQueues.delete(chatId);
        }
      });

    this.chatQueues.set(chatId, next);
  }

  private async getBaseState(): Promise<ApiRuntimeState> {
    if (!this.baseStatePromise) {
      this.baseStatePromise = createApiRuntimeState(this.deps);
    }
    return this.baseStatePromise;
  }

  private async ensureChatSession(chatId: string): Promise<string | null> {
    const mapped = await this.telegramSessions.getSessionId(chatId);
    if (mapped) {
      const existing = await this.deps.sessions.get(mapped);
      if (existing.ok && existing.value) return mapped;
    }

    const baseState = await this.getBaseState();

    const created = await this.deps.sessions.create({
      providerId: baseState.activeProvider.id,
      model: baseState.activeModel,
      activeSkills: this.deps.skillRegistry.activeIds,
    });
    if (!created.ok) throw created.error;

    await this.telegramSessions.setSessionId(chatId, created.value.id);
    await this.deps.settings.setLastActiveSessionId(created.value.id);
    return created.value.id;
  }

  private isAllowed(chatId: string): boolean {
    return this.cfg.allowAll || this.cfg.allowedChatIds.has(chatId);
  }

  private async pollLoop(): Promise<void> {
    let consecutiveErrors = 0;
    let lastErrorMessage = '';

    while (!this.stopped) {
      try {
        const updates = await this.getUpdates();

        if (consecutiveErrors > 0) {
          logger.info('Telegram polling recovered', {
            previousErrors: consecutiveErrors,
          });
        }

        consecutiveErrors = 0;
        lastErrorMessage = '';

        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const chatId = update.message?.chat?.id;
          const text = update.message?.text;
          if (chatId === undefined || typeof text !== 'string' || !text.trim()) continue;
          this.enqueueChatMessage(String(chatId), text);
        }
      } catch (err) {
        consecutiveErrors++;

        const errorMessage = err instanceof Error ? err.message : String(err);
        if (
          this.runtime.logPollingErrors ||
          consecutiveErrors === 1 ||
          errorMessage !== lastErrorMessage
        ) {
          logger.warn('Telegram polling error', {
            error: errorMessage,
            consecutiveErrors,
          });
        }

        lastErrorMessage = errorMessage;

        const delayMs = Math.min(
          this.runtime.retryMaxMs,
          this.runtime.retryMinMs * consecutiveErrors
        );
        await this.sleep(delayMs);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const data = await this.telegramFetch<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: this.runtime.pollTimeoutSeconds,
      allowed_updates: ['message'],
    });
    return data;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      try {
        await this.telegramFetch('sendMessage', {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('Telegram sendMessage failed', { chatId, error: msg });
      }
    }
  }

  private async sendChatAction(chatId: string, action: 'typing' = 'typing'): Promise<void> {
    try {
      await this.telegramFetch('sendChatAction', {
        chat_id: chatId,
        action,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('Telegram sendChatAction failed', { chatId, action, error: msg });
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= MAX_TELEGRAM_MESSAGE) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_TELEGRAM_MESSAGE) {
      chunks.push(text.slice(i, i + MAX_TELEGRAM_MESSAGE));
    }
    return chunks;
  }

  private async telegramFetch<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.cfg.botToken) throw new Error('Telegram bot token is not configured.');
    const response = await networkFetch(`${TELEGRAM_API}/bot${this.cfg.botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json() as TelegramApiResponse<T>;
    if (!response.ok || !data.ok) {
      throw new Error(data.description ?? `Telegram API ${method} failed with HTTP ${response.status}`);
    }
    return (data.result ?? null) as T;
  }

  private async withTelegramTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    ms: number,
    message: string
  ): Promise<T> {
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new TelegramProcessingTimeoutError(message));
      }, ms);
    });

    try {
      return await Promise.race([run(controller.signal), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export async function startTelegramIntegrationIfEnabled(
  deps: ApiDependencies,
  dataDir: string
): Promise<TelegramIntegration | null> {
  const cfg = loadTelegramConfig();
  if (!cfg.enabled) {
    logger.debug('Telegram integration disabled');
    return null;
  }

  const integration = new TelegramIntegration(deps, cfg, dataDir);
  await integration.start();
  return integration;
}
