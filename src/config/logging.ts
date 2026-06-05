import winston from 'winston';
import { getEnvBool } from './env';

export function configureTelegramLogging(baseLogger: winston.Logger): void {
  // Configure telegram-specific logging behavior on the provided logger
  if (shouldLogTelegramPollingError()) {
    baseLogger.debug('Telegram polling error logging is enabled');
  }
  if (shouldLogTelegramRecovery()) {
    baseLogger.debug('Telegram recovery logging is enabled');
  }
}

export const shouldLogTelegramPollingError = () => getEnvBool('TELEGRAM_LOG_POLLING_ERRORS', false);
export const shouldLogTelegramRecovery = () => getEnvBool('TELEGRAM_RECOVERY_LOG_ENABLED', false);