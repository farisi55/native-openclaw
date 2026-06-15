import { execFile } from 'child_process';

export type McpPlatform = NodeJS.Platform;

export interface McpCommandOutput {
  stdout: string;
  stderr: string;
}

export type McpCommandRunner = (
  command: string,
  args: string[],
  options: {
    platform: McpPlatform;
    timeoutMs: number;
  }
) => Promise<McpCommandOutput>;

export function getNpmCommand(platform: McpPlatform = process.platform): string {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function getNpxCommand(platform: McpPlatform = process.platform): string {
  return platform === 'win32' ? 'npx.cmd' : 'npx';
}

export function getBinaryLookupCommand(
  platform: McpPlatform = process.platform
): string {
  return platform === 'win32' ? 'where.exe' : 'which';
}

export const runMcpCommand: McpCommandRunner = (
  command,
  args,
  options
) => new Promise((resolve, reject) => {
  const useWindowsCommandShell =
    options.platform === 'win32' && /\.cmd$/i.test(command);
  const executable = useWindowsCommandShell
    ? process.env['ComSpec'] || 'cmd.exe'
    : command;
  const executableArgs = useWindowsCommandShell
    ? ['/d', '/s', '/c', command, ...args]
    : args;

  execFile(
    executable,
    executableArgs,
    {
      timeout: options.timeoutMs,
      windowsHide: true,
    },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve({ stdout, stderr });
    }
  );
});

export async function getGlobalNpmRoot(
  options: {
    platform?: McpPlatform;
    timeoutMs?: number;
    runner?: McpCommandRunner;
  } = {}
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runMcpCommand;
  try {
    const result = await runner(
      getNpmCommand(platform),
      ['root', '-g'],
      {
        platform,
        timeoutMs: options.timeoutMs ?? 10_000,
      }
    );
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}
