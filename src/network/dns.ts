/**
 * network/dns.ts
 * Optional DNS helpers and diagnostics.
 */

import { lookup, Resolver, setDefaultResultOrder } from 'dns';
import { promisify } from 'util';

const lookupAsync = promisify(lookup);

export interface DnsResolveResult {
  host: string;
  servers: string[];
  addresses: string[];
}

export interface NetworkCheckResult extends DnsResolveResult {
  ok: boolean;
  error?: string;
}

export function getDnsServers(): string[] {
  return (process.env['DNS_SERVERS'] ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);
}

export function configureDnsDefaults(): void {
  try {
    setDefaultResultOrder('ipv4first');
  } catch {
    // Older Node versions may not support this. Keep OS defaults.
  }
}

export async function resolveHost(host: string): Promise<DnsResolveResult> {
  const cleanHost = normalizeHost(host);
  const servers = getDnsServers();

  if (servers.length > 0) {
    const resolver = new Resolver();
    resolver.setServers(servers);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const resolve6 = promisify(resolver.resolve6.bind(resolver));
    const [v4, v6] = await Promise.allSettled([
      resolve4(cleanHost),
      resolve6(cleanHost),
    ]);
    const addresses = [
      ...(v4.status === 'fulfilled' ? v4.value as string[] : []),
      ...(v6.status === 'fulfilled' ? v6.value as string[] : []),
    ];
    if (addresses.length > 0) {
      return { host: cleanHost, servers, addresses };
    }
  }

  const result = await lookupAsync(cleanHost, { all: true });
  return {
    host: cleanHost,
    servers,
    addresses: result.map((entry) => entry.address),
  };
}

export async function networkCheck(host: string): Promise<NetworkCheckResult> {
  try {
    const result = await resolveHost(host);
    return {
      ...result,
      ok: result.addresses.length > 0,
    };
  } catch (err) {
    return {
      host: normalizeHost(host),
      servers: getDnsServers(),
      addresses: [],
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) throw new Error('Host is required.');
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return trimmed.replace(/:\d+$/, '');
  }
}
