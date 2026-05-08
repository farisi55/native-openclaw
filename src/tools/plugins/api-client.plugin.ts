/**
 * Plugin entry for api-client tool.
 * Delegates to the existing api-client module.
 */
import { runApiClient } from '../api-client';

export async function run(input: { path: string } | Record<string, string>): Promise<string> {
  const inp = input as Record<string, string>;
  const path = typeof input === 'string' ? input : (inp['path'] ?? inp['query'] ?? '/');
  const result = await runApiClient(path);
  return result.content;
}
