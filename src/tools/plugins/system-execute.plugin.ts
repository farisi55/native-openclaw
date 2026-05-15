/**
 * Plugin entry for system-execute tool.
 */
import { runSystemExecute } from '../system-execute';

export async function run(input: Record<string, unknown> | string): Promise<string> {
  const result = await runSystemExecute(input as string);
  return result.content;
}