/**
 * Plugin entry for web-fetch tool.
 * Delegates to the existing web-fetch module.
 */
import { runWebFetch } from '../web-fetch';

export async function run(input: { query: string } | Record<string, string>): Promise<string> {
  const query = typeof input === 'string' ? input : (input.query ?? String(input));
  const result = await runWebFetch(query);
  return result.content;
}
