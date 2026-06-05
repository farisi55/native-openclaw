/**
 * Plugin entry for opencode-agent tool.
 */
import { runOpenCodeAgent, type OpenCodeAgentInput } from '../opencode-agent';

export async function run(input: OpenCodeAgentInput | Record<string, unknown> | string): Promise<string> {
  const result = await runOpenCodeAgent(input as OpenCodeAgentInput | string);
  return JSON.stringify(result, null, 2);
}

