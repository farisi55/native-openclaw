import { workspaceAppend } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceAppend(input);
  return result.content;
}

