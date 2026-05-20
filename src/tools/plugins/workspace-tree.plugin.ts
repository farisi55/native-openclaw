import { workspaceTree } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceTree(input);
  return result.content;
}
