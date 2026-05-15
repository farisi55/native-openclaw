/**
 * Plugin entry for api-client tool.
 * Supports full curl-equivalent requests.
 */
import { runApiClient, type ApiClientInput } from '../api-client';

export async function run(input: ApiClientInput | Record<string, unknown> | string): Promise<string> {
  if (typeof input === 'string') {
    const result = await runApiClient({ path: input });
    return result.content;
  }
  const result = await runApiClient(input as ApiClientInput);
  return result.content;
}
