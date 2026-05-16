import { getEnvBool, getOptionalEnv } from '../config';
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
  };
  if (token) cfg.botToken = token;
  return cfg;
}

export class TelegramIntegration {
  private offset = 0;
  private stopped = true;
  private baseState: ApiRuntimeState | null = null;
  private readonly telegramSessions: TelegramSessionManager;

  constructor(
    private readonly deps: ApiDependencies,
    private readonly cfg: TelegramConfig,
    dataDir: string
  ) {
    this.telegramSessions = new TelegramSessionManager(dataDir);
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

    this.baseState = await createApiRuntimeState(this.deps);
    this.stopped = false;
    void this.pollLoop();
    logger.info('Telegram integration started');
  }

  stop(): void {
    this.stopped = true;
  }

  async handleIncomingText(chatId: string, text: string): Promise<boolean> {
    if (!this.isAllowed(chatId)) return false;
    if (!this.baseState) {
      this.baseState = await createApiRuntimeState(this.deps);
    }

    const sessionId = await this.ensureChatSession(chatId);
    const state: ApiRuntimeState = {
      activeProvider: this.baseState.activeProvider,
      activeModel: this.baseState.activeModel,
      activeSessionId: sessionId,
    };

    const response = await handleChatRoute(
      { message: text, sessionId: state.activeSessionId ?? undefined },
      this.deps,
      state
    );

    if (response.body.sessionId) {
      await this.telegramSessions.setSessionId(chatId, response.body.sessionId);
    }

    this.baseState.activeProvider = state.activeProvider;
    this.baseState.activeModel = state.activeModel;

    const reply = response.body.error_detail.length > 0
      ? `Error: ${response.body.error_detail.join('; ')}`
      : response.body.result ?? '';

    await this.sendText(chatId, reply || '(empty response)');
    return true;
  }

  private async ensureChatSession(chatId: string): Promise<string | null> {
    const mapped = await this.telegramSessions.getSessionId(chatId);
    if (mapped) {
      const existing = await this.deps.sessions.get(mapped);
      if (existing.ok && existing.value) return mapped;
    }

    if (!this.baseState) return null;

    const created = await this.deps.sessions.create({
      providerId: this.baseState.activeProvider.id,
      model: this.baseState.activeModel,
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
    while (!this.stopped) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const chatId = update.message?.chat?.id;
          const text = update.message?.text;
          if (chatId === undefined || !text) continue;
          await this.handleIncomingText(String(chatId), text);
        }
      } catch (err) {
        logger.warn('Telegram polling error', {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(3000);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const data = await this.telegramFetch<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: 25,
      allowed_updates: ['message'],
    });
    return data;
  }

  private async sendText(chatId: string, text: string): Promise<void> {
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      await this.telegramFetch('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      });
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
