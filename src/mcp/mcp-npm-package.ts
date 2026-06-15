import {
  getNpmCommand,
  runMcpCommand,
  type McpCommandRunner,
  type McpPlatform,
} from './mcp-platform';

const NPM_PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

export interface NpmPackageValidationResult {
  ok: boolean;
  packageName: string;
  version?: string;
  error?: string;
}

export type NpmPackageValidator = (
  packageName: string,
  timeoutMs: number
) => Promise<NpmPackageValidationResult>;

export function extractNpxPackage(command: string, args: string[] = []): string | undefined {
  const launcher = command
    .trim()
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.cmd$/, '');
  if (launcher !== 'npx') return undefined;
  return args.find((arg) => !arg.startsWith('-') && NPM_PACKAGE_RE.test(arg));
}

export function validateNpmPackageName(packageName: string): void {
  if (!NPM_PACKAGE_RE.test(packageName)) {
    throw new Error(`Invalid npm package name: ${packageName}`);
  }
}

export function createNpmPackageValidator(options: {
  platform?: McpPlatform;
  runner?: McpCommandRunner;
} = {}): NpmPackageValidator {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runMcpCommand;
  return async (packageName, timeoutMs) => {
    validateNpmPackageName(packageName);
    try {
      const result = await runner(
        getNpmCommand(platform),
        ['view', packageName, 'version', '--json'],
        { platform, timeoutMs }
      );
      const raw = result.stdout.trim();
      let version = raw;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'string') version = parsed;
        if (Array.isArray(parsed)) version = String(parsed.at(-1) ?? '');
      } catch {
        // npm may return a plain version string depending on local configuration.
      }
      return {
        ok: true,
        packageName,
        ...(version ? { version } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        packageName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

export const validateNpmPackageExists = createNpmPackageValidator();
