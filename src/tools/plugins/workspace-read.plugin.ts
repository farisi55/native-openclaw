import { workspaceRead } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceRead(input);
  return result.content;
}

