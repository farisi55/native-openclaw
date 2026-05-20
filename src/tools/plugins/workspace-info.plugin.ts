import { workspaceInfo } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceInfo(input);
  return result.content;
}
