import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { networkFetch } from '../network';
import { redactSecrets } from '../self-healing/log-redactor';
import { sendBrevoEmail, type BrevoEmailResult } from '../tools/brevo-email';
import { createLogger } from '../utils/logger';

const logger = createLogger('runtime:restart-notifier');
const TELEGRAM_API = 'https://api.telegram.org';
const PENDING_FILE = 'restart-pending.json';

export interface RestartNotificationInput {
  runId: string;
  runType: 'self-healing' | 'self-upgrade';
  status: 'passed';
  restartRequired: boolean;
  autoRestartScheduled: boolean;
  delayMs: number;
  exitCode: number;
  reason: string;
  changedFiles: string[];
  summary: string;
  timestamp: string;
}

export interface RestartNotificationResult {
  ok: boolean;
  telegram?: {
    attempted: boolean;
    ok: boolean;
    error?: string;
  };
  email?: {
    attempted: boolean;
    ok: boolean;
    error?: string;
  };
  errors: string[];
}

export interface RestartNotifierDeps {
  sendTelegram?: (input: { chatId: string; text: string; timeoutMs: number }) => Promise<void>;
  sendEmail?: (input: {
    subject: string;
    htmlContent: string;
    recipientEmail?: string;
  }) => Promise<Pick<BrevoEmailResult, 'ok' | 'error' | 'content'>>;
}

type NotificationEvent = 'pre-exit' | 'after-start';

export async function sendRestartNotifications(
  input: RestartNotificationInput,
  deps: RestartNotifierDeps = {}
): Promise<RestartNotificationResult> {
  return sendRestartNotificationEvent(input, 'pre-exit', deps);
}

export async function writeRestartPendingNotification(input: RestartNotificationInput): Promise<void> {
  if (!getEnvBool('RESTART_NOTIFY_AFTER_START', true)) return;
  const filePath = restartPendingFilePath();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(filePath, JSON.stringify(input, null, 2), 'utf-8');
}

export async function sendPendingRestartNotificationIfAny(
  deps: RestartNotifierDeps = {}
): Promise<RestartNotificationResult | null> {
  if (!getEnvBool('RESTART_NOTIFY_AFTER_START', true)) return null;

  const filePath = restartPendingFilePath();
  let input: RestartNotificationInput;
  try {
    input = JSON.parse(await readFile(filePath, 'utf-8')) as RestartNotificationInput;
  } catch {
    return null;
  }

  const result = await sendRestartNotificationEvent(input, 'after-start', deps);
  await unlink(filePath).catch((err: unknown) => {
    logger.warn('restart pending marker removal failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return result;
}

async function sendRestartNotificationEvent(
  input: RestartNotificationInput,
  event: NotificationEvent,
  deps: RestartNotifierDeps
): Promise<RestartNotificationResult> {
  if (!getEnvBool('RESTART_NOTIFICATION_ENABLED', true)) {
    return {
      ok: true,
      telegram: { attempted: false, ok: true },
      email: { attempted: false, ok: true },
      errors: [],
    };
  }

  const timeoutMs = Math.max(1, getEnvInt('RESTART_NOTIFICATION_TIMEOUT_MS', 10_000));
  const text = redactSecrets(formatTelegramMessage(input, event));
  const htmlContent = redactSecrets(formatEmailHtml(input, event));
  const subject = redactSecrets(formatEmailSubject(input, event));

  const [telegram, email] = await Promise.all([
    notifyTelegram(text, timeoutMs, deps),
    notifyEmail(subject, htmlContent, timeoutMs, deps),
  ]);

  const errors = [
    telegram.error && telegram.attempted ? `telegram: ${telegram.error}` : '',
    email.error && email.attempted ? `email: ${email.error}` : '',
  ].filter(Boolean);

  return {
    ok: errors.length === 0,
    telegram,
    email,
    errors,
  };
}

async function notifyTelegram(
  text: string,
  timeoutMs: number,
  deps: RestartNotifierDeps
): Promise<NonNullable<RestartNotificationResult['telegram']>> {
  if (!getEnvBool('RESTART_NOTIFY_TELEGRAM', true)) {
    return { attempted: false, ok: true };
  }

  const botToken = clean(getOptionalEnv('TELEGRAM_BOT_TOKEN'));
  if (!botToken) {
    logger.warn('restart Telegram notification skipped; TELEGRAM_BOT_TOKEN is not configured');
    return { attempted: false, ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured.' };
  }

  const chatId = resolveTelegramChatId();
  if (!chatId) {
    logger.warn('restart Telegram notification skipped; no chat id configured');
    return { attempted: false, ok: false, error: 'No Telegram chat id configured.' };
  }

  try {
    await withTimeout(
      (deps.sendTelegram ?? defaultSendTelegram)({ chatId, text, timeoutMs }),
      timeoutMs,
      'Telegram restart notification timed out.'
    );
    return { attempted: true, ok: true };
  } catch (err) {
    const error = redactSecrets(err instanceof Error ? err.message : String(err));
    logger.warn('restart Telegram notification failed', { error });
    return { attempted: true, ok: false, error };
  }
}

async function notifyEmail(
  subject: string,
  htmlContent: string,
  timeoutMs: number,
  deps: RestartNotifierDeps
): Promise<NonNullable<RestartNotificationResult['email']>> {
  if (!getEnvBool('RESTART_NOTIFY_EMAIL', true)) {
    return { attempted: false, ok: true };
  }

  const recipientEmail = resolveEmailRecipient();
  if (!recipientEmail) {
    logger.warn('restart email notification skipped; no recipient configured');
    return { attempted: false, ok: false, error: 'No restart email recipient configured.' };
  }

  try {
    const result = await withTimeout(
      (deps.sendEmail ?? defaultSendEmail)({ subject, htmlContent, recipientEmail }),
      timeoutMs,
      'Email restart notification timed out.'
    );

    if (!result.ok) {
      const error = redactSecrets(result.error ?? result.content ?? 'Brevo email notification failed.');
      return { attempted: true, ok: false, error };
    }

    return { attempted: true, ok: true };
  } catch (err) {
    const error = redactSecrets(err instanceof Error ? err.message : String(err));
    logger.warn('restart email notification failed', { error });
    return { attempted: true, ok: false, error };
  }
}

async function defaultSendTelegram(input: { chatId: string; text: string; timeoutMs: number }): Promise<void> {
  const token = getOptionalEnv('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await networkFetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (!response.ok || data.ok === false) {
      throw new Error(data.description ?? `Telegram sendMessage failed with HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function defaultSendEmail(input: {
  subject: string;
  htmlContent: string;
  recipientEmail?: string;
}): Promise<Pick<BrevoEmailResult, 'ok' | 'error' | 'content'>> {
  return sendBrevoEmail(input);
}

function resolveTelegramChatId(): string | undefined {
  const explicit = clean(getOptionalEnv('RESTART_TELEGRAM_CHAT_ID'));
  if (explicit) return explicit;
  if (!getEnvBool('RESTART_TELEGRAM_USE_DEFAULT_CHAT', true)) return undefined;

  const admin = clean(getOptionalEnv('TELEGRAM_ADMIN_CHAT_ID'));
  if (admin) return admin;

  const allowedRaw = getOptionalEnv('TELEGRAM_ALLOWED_CHAT_IDS', '') ?? '';
  return allowedRaw
    .split(',')
    .map((item) => item.trim())
    .find(Boolean);
}

function resolveEmailRecipient(): string | undefined {
  const explicit = clean(getOptionalEnv('RESTART_EMAIL_RECIPIENT'));
  if (explicit) return explicit;
  if (!getEnvBool('RESTART_EMAIL_USE_BREVO_DEFAULTS', true)) return undefined;
  return clean(getOptionalEnv('BREVO_RECIPIENT_EMAIL'));
}

function formatTelegramMessage(input: RestartNotificationInput, event: NotificationEvent): string {
  if (event === 'after-start') {
    return [
      'smooth restarted successfully',
      '',
      'Previous run:',
      input.runType,
      `Run ID: ${input.runId}`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join('\n');
  }

  return [
    'smooth restart required',
    '',
    `Run: ${input.runType}`,
    `Run ID: ${input.runId}`,
    `Status: ${input.status}`,
    `Restart: ${input.autoRestartScheduled ? 'scheduled' : 'required'}`,
    `Exit code: ${input.exitCode}`,
    `Delay: ${formatDelay(input.delayMs)}`,
    `Reason: ${input.reason}`,
    '',
    formatChangedFiles(input.changedFiles),
    '',
    input.summary,
    '',
    formatRestartHint(),
  ].filter(Boolean).join('\n');
}

function formatEmailSubject(input: RestartNotificationInput, event: NotificationEvent): string {
  if (event === 'after-start') return '[smooth] Restarted Successfully';
  return input.runType === 'self-healing'
    ? '[smooth] Restart Required After Self-Healing'
    : '[smooth] Restart Required After Self-Upgrade';
}

function formatEmailHtml(input: RestartNotificationInput, event: NotificationEvent): string {
  if (event === 'after-start') {
    return [
      '<h2>smooth restarted successfully</h2>',
      '<p>The app has started after a pending autonomous restart request.</p>',
      '<ul>',
      `<li><strong>Previous run:</strong> ${escapeHtml(input.runType)}</li>`,
      `<li><strong>Run ID:</strong> ${escapeHtml(input.runId)}</li>`,
      `<li><strong>Timestamp:</strong> ${escapeHtml(new Date().toISOString())}</li>`,
      '</ul>',
    ].join('\n');
  }

  return [
    '<h2>smooth restart required</h2>',
    '<p>An autonomous maintenance run passed QA and requested a process restart.</p>',
    '<ul>',
    `<li><strong>Run:</strong> ${escapeHtml(input.runType)}</li>`,
    `<li><strong>Run ID:</strong> ${escapeHtml(input.runId)}</li>`,
    `<li><strong>Status:</strong> ${escapeHtml(input.status)}</li>`,
    `<li><strong>Restart:</strong> ${input.autoRestartScheduled ? 'scheduled' : 'required'}</li>`,
    `<li><strong>Exit code:</strong> ${input.exitCode}</li>`,
    `<li><strong>Delay:</strong> ${escapeHtml(formatDelay(input.delayMs))}</li>`,
    `<li><strong>Reason:</strong> ${escapeHtml(input.reason)}</li>`,
    `<li><strong>Timestamp:</strong> ${escapeHtml(input.timestamp)}</li>`,
    '</ul>',
    '<h3>Changed files</h3>',
    formatChangedFilesHtml(input.changedFiles),
    '<h3>Summary</h3>',
    `<p>${escapeHtml(input.summary)}</p>`,
    getEnvBool('RESTART_NOTIFICATION_INCLUDE_RESTART_HINT', true)
      ? [
          '<h3>Manual verification</h3>',
          '<p>If smooth does not come back automatically, restart it manually:</p>',
          '<ul>',
          '<li><code>npm start</code></li>',
          '<li><code>npm run start:watch:win</code></li>',
          '<li><code>npm run start:watch:unix</code></li>',
          '<li><code>docker compose up -d</code></li>',
          '<li><code>pm2 restart smooth</code></li>',
          '</ul>',
        ].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

function formatChangedFiles(files: string[]): string {
  if (!getEnvBool('RESTART_NOTIFICATION_INCLUDE_CHANGED_FILES', true)) return '';
  if (files.length === 0) return 'Changed files: none';
  return ['Changed files:', ...files.map((file) => `- ${file}`)].join('\n');
}

function formatChangedFilesHtml(files: string[]): string {
  if (!getEnvBool('RESTART_NOTIFICATION_INCLUDE_CHANGED_FILES', true)) return '<p>Changed files omitted by config.</p>';
  if (files.length === 0) return '<p>None.</p>';
  return `<ul>${files.map((file) => `<li>${escapeHtml(file)}</li>`).join('')}</ul>`;
}

function formatRestartHint(): string {
  if (!getEnvBool('RESTART_NOTIFICATION_INCLUDE_RESTART_HINT', true)) return '';
  return [
    'Manual check:',
    'If smooth does not come back automatically, restart it manually:',
    '- npm start',
    '- npm run start:watch:win',
    '- npm run start:watch:unix',
    '- docker compose up -d',
    '- pm2 restart smooth',
  ].join('\n');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatDelay(ms: number): string {
  if (ms >= 1000) {
    const seconds = ms / 1000;
    return `${Number.isInteger(seconds) ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function dataDir(): string {
  return getOptionalEnv('APP_DATA_DIR', '.data') ?? '.data';
}

function restartPendingFilePath(): string {
  return join(dataDir(), PENDING_FILE);
}
