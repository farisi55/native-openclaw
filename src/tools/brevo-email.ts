import { readFile } from 'fs/promises';
import { basename } from 'path';
import { networkFetch } from '../network';

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
  status?: number;
  messageId?: string;
  content: string;
  missingEnv?: string[];
  error?: string;
}

interface BrevoApiResponse {
  messageId?: string;
  code?: string;
  message?: string;
}

function readInput(input: unknown): BrevoEmailInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as BrevoEmailInput;
}

function missingEnvFor(input: BrevoEmailInput): string[] {
  const missing: string[] = [];
  if (!process.env['BREVO_API_KEY']) missing.push('BREVO_API_KEY');
  if (!input.senderEmail && !process.env['BREVO_SENDER_EMAIL']) missing.push('BREVO_SENDER_EMAIL');
  if (!input.recipientEmail && !process.env['BREVO_RECIPIENT_EMAIL']) missing.push('BREVO_RECIPIENT_EMAIL');
  return missing;
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
  const htmlContent = parsed.htmlContent?.trim();
  const missing = missingEnvFor(parsed);

  if (!subject) missing.push('subject');
  if (!htmlContent) missing.push('htmlContent');

  if (missing.length > 0) {
    return {
      ok: false,
      content: `Brevo email not sent. Missing: ${missing.join(', ')}`,
      missingEnv: missing,
    };
  }

  const senderEmail = parsed.senderEmail ?? process.env['BREVO_SENDER_EMAIL']!;
  const senderName = parsed.senderName ?? process.env['BREVO_SENDER_NAME'] ?? 'Native OpenClaw';
  const recipientEmail = parsed.recipientEmail ?? process.env['BREVO_RECIPIENT_EMAIL']!;
  const recipientName = parsed.recipientName ?? process.env['BREVO_RECIPIENT_NAME'] ?? recipientEmail;

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
        'api-key': process.env['BREVO_API_KEY']!,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({})) as BrevoApiResponse;

    if (!response.ok) {
      const message = body.message ?? `Brevo HTTP ${response.status}`;
      return {
        ok: false,
        status: response.status,
        content: `Brevo email not sent. ${message}`,
        error: message,
      };
    }

    const result: BrevoEmailResult = {
      ok: true,
      status: response.status,
      content: `Brevo email sent${body.messageId ? `: ${body.messageId}` : '.'}`,
    };
    if (body.messageId) result.messageId = body.messageId;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      content: `Brevo email not sent. ${message}`,
      error: message,
    };
  }
}
