import { workspaceTrash } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceTrash(input);
  return result.content;
}
