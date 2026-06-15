import { execFile } from 'child_process';

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
  if (command.trim().split(/[\\/]/).at(-1)?.toLowerCase() !== 'npx') return undefined;
  return args.find((arg) => !arg.startsWith('-') && NPM_PACKAGE_RE.test(arg));
}

export function validateNpmPackageName(packageName: string): void {
  if (!NPM_PACKAGE_RE.test(packageName)) {
    throw new Error(`Invalid npm package name: ${packageName}`);
  }
}

export const validateNpmPackageExists: NpmPackageValidator = (
  packageName,
  timeoutMs
) => {
  validateNpmPackageName(packageName);
  return new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', packageName, 'version', '--json'],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            packageName,
            error: (stderr || error.message).trim(),
          });
          return;
        }
        const raw = stdout.trim();
        let version = raw;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed === 'string') version = parsed;
          if (Array.isArray(parsed)) version = String(parsed.at(-1) ?? '');
        } catch {
          // npm may return a plain version string depending on local configuration.
        }
        resolve({
          ok: true,
          packageName,
          ...(version ? { version } : {}),
        });
      }
    );
  });
};
