import { workspaceMkdir } from '../../workspace';

export async function run(input: unknown): Promise<string> {
  const result = await workspaceMkdir(input);
  return result.content;
}

