export {
  createFetchWithProxy,
  getDispatcherForUrl,
  getProxyConfig,
  getProxyForUrl,
  maskProxyUrl,
  networkFetch,
  setupGlobalProxy,
  shouldBypassProxy,
} from './proxy';
export type { ProxyConfig } from './proxy';

export {
  configureDnsDefaults,
  getDnsServers,
  networkCheck,
  resolveHost,
} from './dns';
export type { DnsResolveResult, NetworkCheckResult } from './dns';
