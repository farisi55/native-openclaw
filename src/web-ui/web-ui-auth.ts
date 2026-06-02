import { createHmac, timingSafeEqual } from 'crypto';
import type { WebUiConfig } from './web-ui-types';

interface SessionPayload {
  sub: string;
  exp: number;
  nonce: string;
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf-8');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function validateCredentials(username: string, password: string, config: WebUiConfig): boolean {
  return safeEqual(username, config.username) && safeEqual(password, config.password);
}

export function createSessionCookie(config: WebUiConfig, now = Date.now()): string {
  const payload: SessionPayload = {
    sub: config.username,
    exp: now + config.sessionTtlMs,
    nonce: createHmac('sha256', `${now}:${Math.random()}`).update(config.sessionSecret).digest('hex').slice(0, 16),
  };
  const encoded = base64Url(JSON.stringify(payload));
  const signature = sign(encoded, config.sessionSecret);
  const maxAge = Math.max(1, Math.floor(config.sessionTtlMs / 1000));
  return [
    `${config.cookieName}=${encodeURIComponent(`${encoded}.${signature}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function clearSessionCookie(config: WebUiConfig): string {
  return `${config.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isAuthenticated(cookieHeader: string | undefined, config: WebUiConfig, now = Date.now()): boolean {
  const raw = parseCookieHeader(cookieHeader).get(config.cookieName);
  if (!raw) return false;

  const [encoded, signature] = raw.split('.');
  if (!encoded || !signature) return false;
  if (!safeEqual(sign(encoded, config.sessionSecret), signature)) return false;

  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as Partial<SessionPayload>;
    return parsed.sub === config.username && typeof parsed.exp === 'number' && parsed.exp > now;
  } catch {
    return false;
  }
}
