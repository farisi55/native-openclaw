import { logger } from '../../config/logger';
import { shouldLogTelegramPollingError, shouldLogTelegramRecovery } from '../../config/logging';

let isRecovering = false;

const handlePollingError = (error: Error) => {
  if (shouldLogTelegramPollingError()) {
    logger.error('Telegram polling error:', error);
  }
};

const handleRecovery = () => {
  if (shouldLogTelegramRecovery()) {
    logger.info('Telegram polling recovered from error');
  }
  isRecovering = false;
};

const startPolling = async (bot: any) => {
  bot.startPolling();
  bot.on('polling_error', (error: Error) => {
    isRecovering = true;
    handlePollingError(error);
  });
  bot.on('error', (error: Error) => {
    if (!isRecovering) {
      handlePollingError(error);
    }
  });
};

export default { startPolling, handleRecovery };