/**
 * Plugin entry for system-time tool.
 * Delegates to the existing system module.
 */
import { runSystemTool } from '../system';

export async function run(input: { query: string } | Record<string, string>): Promise<string> {
  const query = typeof input === 'string' ? input : (input.query ?? 'time');
  const result = runSystemTool(query);
  return result.content;
}
