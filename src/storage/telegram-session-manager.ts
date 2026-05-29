/**
 * storage/telegram-session-manager.ts
 * Persists Telegram chat id -> Native OpenClaw session id mappings.
 */

import { join } from 'path';
import { KVStore } from './json-store';
import { createLogger } from '../utils/logger';

const logger = createLogger('storage:telegram');

export class TelegramSessionManager {
  private readonly kv: KVStore;

  constructor(dataDir: string) {
    this.kv = new KVStore({ dataDir, fileName: 'telegram-sessions' });
    logger.debug('telegram session store initialised', {
      path: join(dataDir, 'telegram-sessions.json'),
    });
  }

  async getSessionId(chatId: string): Promise<string | null> {
    const result = await this.kv.get<string>(chatId);
    return result.ok ? result.value : null;
  }

  async setSessionId(chatId: string, sessionId: string): Promise<void> {
    await this.kv.set(chatId, sessionId);
    logger.debug('telegram chat session saved', { chatId, sessionId });
  }

  async getAllChatIds(): Promise<string[]> {
    const result = await this.kv.all();
    if (!result.ok) return [];
    return Object.keys(result.value);
  }

  async deleteSessionId(chatId: string): Promise<void> {
    await this.kv.delete(chatId);
    logger.debug('telegram chat session deleted', { chatId });
  }
}
