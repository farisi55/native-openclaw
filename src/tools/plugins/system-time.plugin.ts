/**
 * Plugin entry for system-time tool.
 */
import { runSystemTool } from '../system';

export async function run(input: { query?: string } | Record<string, unknown> | string): Promise<string> {
  const result = runSystemTool(input as string);
  return result.content;
}
