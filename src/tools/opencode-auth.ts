import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';
import { redactSecrets } from '../self-healing/log-redactor';

export interface OpenCodeAuthBootstrapResult {
  ok: boolean;
  authFile: string;
  provider: string;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  warning?: string;
  reason: string;
}

export interface OpenCodeAuthStatus {
  authFile: string;
  provider: string;
  authFileExists: boolean;
  providerExists: boolean;
  providerWarning?: string;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function configuredProvider(): string {
  return (process.env['OPENCODE_AUTH_PROVIDER'] || 'opencode').trim() || 'opencode';
}

export function defaultOpenCodeAuthFile(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData && localAppData.trim()) {
      return resolve(localAppData, 'opencode', 'auth.json');
    }
    return resolve(homedir(), 'AppData', 'Local', 'opencode', 'auth.json');
  }
  return resolve(homedir(), '.local', 'share', 'opencode', 'auth.json');
}

export function resolveOpenCodeAuthFile(): string {
  const configured = (process.env['OPENCODE_AUTH_FILE'] || '').trim();
  return configured ? resolve(configured) : defaultOpenCodeAuthFile();
}

function providerWarning(provider: string): string | undefined {
  return provider.toLowerCase() === 'opencode-zen'
    ? "OpenCode provider id should be 'opencode', not 'opencode-zen'. Models should use opencode/..."
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readAuthJson(authFile: string): Promise<Record<string, unknown>> {
  if (!existsSync(authFile)) return {};
  const raw = await readFile(authFile, 'utf-8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function hasProvider(container: unknown, provider: string): boolean {
  return isRecord(container) && Object.prototype.hasOwnProperty.call(container, provider);
}

export function openCodeAuthHasProvider(auth: Record<string, unknown>, provider: string): boolean {
  if (hasProvider(auth, provider)) return true;
  if (hasProvider(auth['providers'], provider)) return true;
  if (hasProvider(auth['auth'], provider)) return true;
  return false;
}

function mergeAuthRecord(existing: unknown, apiKey: string): Record<string, unknown> {
  return {
    ...(isRecord(existing) ? existing : {}),
    type: isRecord(existing) && typeof existing['type'] === 'string' ? existing['type'] : 'api',
    key: apiKey,
  };
}

function writeProviderAuth(auth: Record<string, unknown>, provider: string, apiKey: string): Record<string, unknown> {
  if (isRecord(auth['providers'])) {
    auth['providers'] = {
      ...auth['providers'],
      [provider]: mergeAuthRecord(auth['providers'][provider], apiKey),
    };
    return auth;
  }

  if (isRecord(auth['auth'])) {
    auth['auth'] = {
      ...auth['auth'],
      [provider]: mergeAuthRecord(auth['auth'][provider], apiKey),
    };
    return auth;
  }

  auth[provider] = mergeAuthRecord(auth[provider], apiKey);
  return auth;
}

export async function getOpenCodeAuthStatus(): Promise<OpenCodeAuthStatus> {
  const authFile = resolveOpenCodeAuthFile();
  const provider = configuredProvider();
  const warning = providerWarning(provider);
  const authFileExists = existsSync(authFile);
  let providerExists = false;
  if (authFileExists) {
    try {
      providerExists = openCodeAuthHasProvider(await readAuthJson(authFile), provider);
    } catch {
      providerExists = false;
    }
  }
  return {
    authFile,
    provider,
    authFileExists,
    providerExists,
    ...(warning ? { providerWarning: warning } : {}),
  };
}

export async function bootstrapOpenCodeAuthFromEnv(): Promise<OpenCodeAuthBootstrapResult> {
  const authFile = resolveOpenCodeAuthFile();
  const provider = configuredProvider();
  const warning = providerWarning(provider);

  if (!envBool('OPENCODE_AUTH_BOOTSTRAP', false)) {
    return {
      ok: true,
      authFile,
      provider,
      created: false,
      updated: false,
      skipped: true,
      ...(warning ? { warning } : {}),
      reason: 'OPENCODE_AUTH_BOOTSTRAP is not true.',
    };
  }

  const apiKey = process.env['OPENCODE_ZEN_API_KEY'] || '';
  if (!apiKey.trim()) {
    return {
      ok: true,
      authFile,
      provider,
      created: false,
      updated: false,
      skipped: true,
      ...(warning ? { warning } : {}),
      reason: 'OPENCODE_ZEN_API_KEY is empty.',
    };
  }

  if (warning) {
    return {
      ok: true,
      authFile,
      provider,
      created: false,
      updated: false,
      skipped: true,
      warning,
      reason: "OPENCODE_AUTH_PROVIDER should be 'opencode'. Auth bootstrap was skipped.",
    };
  }

  try {
    const existed = existsSync(authFile);
    const auth = await readAuthJson(authFile);
    const providerExists = openCodeAuthHasProvider(auth, provider);
    const overwrite = envBool('OPENCODE_AUTH_OVERWRITE', false);

    if (providerExists && !overwrite) {
      return {
        ok: true,
        authFile,
        provider,
        created: false,
        updated: false,
        skipped: true,
        reason: `Provider ${provider} already exists and OPENCODE_AUTH_OVERWRITE=false.`,
      };
    }

    const nextAuth = writeProviderAuth(auth, provider, apiKey);
    await mkdir(dirname(authFile), { recursive: true });
    await writeFile(authFile, `${JSON.stringify(nextAuth, null, 2)}\n`, 'utf-8');
    if (process.platform !== 'win32') {
      await chmod(authFile, 0o600).catch(() => undefined);
    }

    return {
      ok: true,
      authFile,
      provider,
      created: !existed,
      updated: existed,
      skipped: false,
      reason: existed ? `Provider ${provider} auth was updated.` : `Provider ${provider} auth was created.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      authFile,
      provider,
      created: false,
      updated: false,
      skipped: false,
      reason: redactSecrets(`OpenCode auth bootstrap failed: ${message}`),
    };
  }
}
