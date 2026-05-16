/**
 * network/proxy.ts
 * Optional proxy-aware fetch support for Node 20 native fetch.
 */

import { createRequire } from 'module';

const requireFromHere = createRequire(__filename);

export interface ProxyConfig {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string[];
}

type Dispatcher = unknown;

let proxyAgentCtor: ((url: string) => Dispatcher) | null | undefined;
const dispatcherCache = new Map<string, Dispatcher>();

export function getProxyConfig(): ProxyConfig {
  return {
    httpProxy: process.env['HTTP_PROXY'] || process.env['http_proxy'] || null,
    httpsProxy: process.env['HTTPS_PROXY'] || process.env['https_proxy'] || null,
    noProxy: (process.env['NO_PROXY'] || process.env['no_proxy'] || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

export function maskProxyUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
  }
}

export function shouldBypassProxy(url: string | URL): boolean {
  const cfg = getProxyConfig();
  if (cfg.noProxy.length === 0) return false;

  const parsed = typeof url === 'string' ? new URL(url) : url;
  const host = parsed.hostname.toLowerCase();
  const hostPort = `${host}:${parsed.port || defaultPort(parsed.protocol)}`;

  return cfg.noProxy.some((entry) => {
    const rule = entry.toLowerCase();
    if (rule === '*') return true;
    if (rule.includes(':') && rule === hostPort) return true;
    if (rule === host) return true;
    if (rule.startsWith('.')) return host.endsWith(rule);
    return host === rule || host.endsWith(`.${rule}`);
  });
}

export function getProxyForUrl(url: string | URL): string | null {
  const cfg = getProxyConfig();
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (shouldBypassProxy(parsed)) return null;
  return parsed.protocol === 'http:' ? cfg.httpProxy : cfg.httpsProxy ?? cfg.httpProxy;
}

export function getDispatcherForUrl(url: string | URL): Dispatcher | null {
  const proxyUrl = getProxyForUrl(url);
  if (!proxyUrl) return null;

  const ctor = loadProxyAgent();
  if (!ctor) return null;

  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;

  const dispatcher = ctor(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export function createFetchWithProxy(baseFetch: typeof fetch = fetch): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const url = requestUrl(input);
    if (!url) return baseFetch(input, init);

    const dispatcher = getDispatcherForUrl(url);
    if (!dispatcher) return baseFetch(input, init);

    return (baseFetch as unknown as (i: unknown, init?: Record<string, unknown>) => Promise<Response>)(input, {
      ...(init ?? {}),
      dispatcher,
    });
  }) as typeof fetch;
}

export const networkFetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> => createFetchWithProxy(fetch)(input, init)) as typeof fetch;

function requestUrl(input: Parameters<typeof fetch>[0]): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return null;
}

function defaultPort(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function loadProxyAgent(): ((url: string) => Dispatcher) | null {
  if (proxyAgentCtor !== undefined) return proxyAgentCtor;

  try {
    const undici = requireFromHere('undici') as { ProxyAgent?: new (url: string) => Dispatcher };
    proxyAgentCtor = undici.ProxyAgent
      ? (url: string) => new undici.ProxyAgent!(url)
      : null;
  } catch {
    proxyAgentCtor = null;
  }

  return proxyAgentCtor;
}
