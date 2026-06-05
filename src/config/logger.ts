import winston from 'winston';
import { configureTelegramLogging } from './logging';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

configureTelegramLogging(logger);

export { logger };
