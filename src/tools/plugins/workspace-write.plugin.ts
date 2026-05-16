import { workspaceWrite } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceWrite(input);
  return result.content;
}

