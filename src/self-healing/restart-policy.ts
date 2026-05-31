export type RestartRequirementMode = 'self-healing' | 'self-upgrade';

export function isRestartRequiredForChangedFiles(
  changedFiles: string[],
  mode: RestartRequirementMode
): boolean {
  return changedFiles.some((file) => isRestartRequiredForChangedFile(file, mode));
}

export function restartReasonForChangedFiles(
  changedFiles: string[],
  mode: RestartRequirementMode
): string | undefined {
  if (!isRestartRequiredForChangedFiles(changedFiles, mode)) return undefined;
  if (mode === 'self-upgrade') {
    return 'self-upgrade changed source files; restart required for hot registration';
  }
  return 'self-healing changed bootstrap, provider, config, or tool registry files';
}

function isRestartRequiredForChangedFile(file: string, mode: RestartRequirementMode): boolean {
  const normalized = normalizePath(file);

  // Self-upgrade intentionally restarts more aggressively because newly added source
  // capabilities may not be hot-registered in the current process.
  if (mode === 'self-upgrade') {
    return normalized.startsWith('src/');
  }

  // Self-healing is narrower: only process bootstrap/config/provider/tool registry
  // changes require a restart. Ordinary source fixes continue in-process.
  return normalized === 'package.json' ||
    normalized === 'package-lock.json' ||
    normalized === 'tsconfig.json' ||
    normalized === 'src/index.ts' ||
    normalized.startsWith('src/config/') ||
    normalized.startsWith('src/providers/') ||
    normalized.startsWith('src/tools/tool-registry') ||
    normalized.startsWith('src/tools/plugins/');
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}
