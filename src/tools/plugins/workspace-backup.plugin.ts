import { workspaceBackup } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceBackup(input);
  return result.content;
}
