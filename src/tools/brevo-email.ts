import { readFile } from 'fs/promises';
import { basename } from 'path';
import { networkFetch } from '../network';
import { sanitizeHtml } from '../utils/html-sanitizer';

export interface BrevoAttachmentInput {
  path: string;
  name?: string;
}

export interface BrevoEmailInput {
  subject?: string;
  htmlContent?: string;
  senderEmail?: string;
  senderName?: string;
  recipientEmail?: string;
  recipientName?: string;
  attachments?: BrevoAttachmentInput[];
}

export interface BrevoEmailResult {
  ok: boolean;
  provider: 'brevo';
  status?: number;
  messageId?: string;
  content: string;
  missingEnv?: string[];
  error?: string;
  details?: string;
  senderEmail?: string;
  recipientEmail?: string;
}

interface BrevoApiResponse {
  messageId?: string;
  code?: string;
  message?: string;
}

const DEFAULT_SENDER_NAME = 'Native OpenClaw';
const PLACEHOLDER_EMAIL_RE = /^(email|recipient|sender|test|user|example)@example\.com$/i;

function readInput(input: unknown): BrevoEmailInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as BrevoEmailInput;
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isPlaceholderEmail(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower.endsWith('@example.com') || PLACEHOLDER_EMAIL_RE.test(lower);
}

function isPlaceholderName(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return [
    'nama penerima',
    'nama pengirim',
    'recipient name',
    'sender name',
    'test user',
    'example user',
    'your name',
  ].includes(lower);
}

function resolveEmail(inputValue: string | undefined, envValue: string | undefined): string | undefined {
  const inputEmail = cleanString(inputValue);
  if (inputEmail && !isPlaceholderEmail(inputEmail)) return inputEmail;
  return cleanString(envValue);
}

function resolveName(inputValue: string | undefined, envValue: string | undefined, fallback: string): string {
  const inputName = cleanString(inputValue);
  if (inputName && !isPlaceholderName(inputName)) return inputName;
  return cleanString(envValue) ?? fallback;
}

function validateEmail(label: string, value: string | undefined): string | null {
  if (!value) return label;
  if (isPlaceholderEmail(value)) return `${label} placeholder`;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `${label} invalid`;
  return null;
}

async function buildAttachments(attachments: BrevoAttachmentInput[] | undefined): Promise<Array<{ content: string; name: string }> | undefined> {
  if (!attachments || attachments.length === 0) return undefined;

  const encoded: Array<{ content: string; name: string }> = [];
  for (const attachment of attachments) {
    if (!attachment.path) continue;
    const data = await readFile(attachment.path);
    encoded.push({
      content: data.toString('base64'),
      name: attachment.name ?? basename(attachment.path),
    });
  }

  return encoded.length > 0 ? encoded : undefined;
}

export async function sendBrevoEmail(input: unknown): Promise<BrevoEmailResult> {
  const parsed = readInput(input);
  const subject = parsed.subject?.trim();
  const htmlContent = parsed.htmlContent
    ? sanitizeHtml(parsed.htmlContent.trim())
    : undefined;
  const apiKey = cleanString(process.env['BREVO_API_KEY']);
  const senderEmail = resolveEmail(parsed.senderEmail, process.env['BREVO_SENDER_EMAIL']);
  const recipientEmail = resolveEmail(parsed.recipientEmail, process.env['BREVO_RECIPIENT_EMAIL']);
  const senderName = resolveName(parsed.senderName, process.env['BREVO_SENDER_NAME'], DEFAULT_SENDER_NAME);
  const recipientName = resolveName(parsed.recipientName, process.env['BREVO_RECIPIENT_NAME'], recipientEmail ?? 'Recipient');
  const missing: string[] = [];

  if (!apiKey) missing.push('BREVO_API_KEY');
  if (!subject) missing.push('subject');
  if (!htmlContent) missing.push('htmlContent');
  const senderError = validateEmail('senderEmail', senderEmail);
  const recipientError = validateEmail('recipientEmail', recipientEmail);
  if (senderError) missing.push(senderError === 'senderEmail' ? 'BREVO_SENDER_EMAIL' : senderError);
  if (recipientError) missing.push(recipientError === 'recipientEmail' ? 'BREVO_RECIPIENT_EMAIL' : recipientError);

  if (missing.length > 0) {
    const result: BrevoEmailResult = {
      ok: false,
      provider: 'brevo',
      content: `Brevo email not sent. Missing: ${missing.join(', ')}`,
      missingEnv: missing,
    };
    if (senderEmail) result.senderEmail = senderEmail;
    if (recipientEmail) result.recipientEmail = recipientEmail;
    return result;
  }

  if (!apiKey || !senderEmail || !recipientEmail) {
    return {
      ok: false,
      provider: 'brevo',
      content: 'Brevo email not sent. Missing resolved Brevo configuration.',
      missingEnv: ['BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_RECIPIENT_EMAIL'],
    };
  }

  try {
    const attachments = await buildAttachments(parsed.attachments);
    const payload: Record<string, unknown> = {
      sender: {
        email: senderEmail,
        name: senderName,
      },
      to: [
        {
          email: recipientEmail,
          name: recipientName,
        },
      ],
      subject,
      htmlContent,
    };

    if (attachments) payload['attachment'] = attachments;

    const response = await networkFetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await readBrevoResponse(response);

    if (!response.ok) {
      const detail = formatBrevoError(body);
      const message = detail || `Brevo HTTP ${response.status}`;
      return {
        ok: false,
        provider: 'brevo',
        status: response.status,
        content: `Brevo email not sent to ${recipientEmail} from ${senderEmail}. HTTP ${response.status}. ${message}`,
        error: message,
        details: detail,
        senderEmail,
        recipientEmail,
      };
    }

    const result: BrevoEmailResult = {
      ok: true,
      provider: 'brevo',
      status: response.status,
      content: `Brevo email sent to ${recipientEmail} from ${senderEmail}${body.messageId ? `: ${body.messageId}` : '.'}`,
      senderEmail,
      recipientEmail,
    };
    if (body.messageId) result.messageId = body.messageId;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider: 'brevo',
      content: `Brevo email not sent to ${recipientEmail} from ${senderEmail}. ${message}`,
      error: message,
      senderEmail,
      recipientEmail,
    };
  }
}

async function readBrevoResponse(response: Response): Promise<BrevoApiResponse> {
  if (typeof response.text === 'function') {
    const raw = await response.text().catch(() => '');
    if (!raw) return {};
    try {
      return JSON.parse(raw) as BrevoApiResponse;
    } catch {
      return { message: raw };
    }
  }

  return await response.json().catch(() => ({})) as BrevoApiResponse;
}

function formatBrevoError(body: BrevoApiResponse): string {
  if (body.message && body.code) return `${body.message} (${body.code})`;
  if (body.message) return body.message;
  if (body.code) return body.code;
  return '';
}
