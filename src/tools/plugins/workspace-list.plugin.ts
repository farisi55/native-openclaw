import { workspaceList } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceList(input);
  return result.content;
}

