export type RestartRequirementMode = 'self-healing' | 'self-upgrade';

export function isRestartRequiredForChangedFiles(
  changedFiles: string[],
  mode: RestartRequirementMode
): boolean {
  return filterRestartRelevantChangedFiles(changedFiles)
    .some((file) => isRestartRequiredForChangedFile(file, mode));
}

export function restartReasonForChangedFiles(
  changedFiles: string[],
  mode: RestartRequirementMode
): string | undefined {
  const restartFiles = filterRestartRelevantChangedFiles(changedFiles);
  if (!isRestartRequiredForChangedFiles(restartFiles, mode)) return undefined;
  if (mode === 'self-upgrade') {
    return 'self-upgrade changed source files; restart required for hot registration';
  }
  return 'self-healing changed bootstrap, provider, config, or tool registry files';
}

export function filterRestartRelevantChangedFiles(changedFiles: string[]): string[] {
  return [...new Set(changedFiles)]
    .map(normalizePath)
    .filter((file) => file.length > 0 && !isIgnoredChangedFile(file))
    .sort();
}

export function isIgnoredChangedFile(file: string): boolean {
  const normalized = normalizePath(file);
  const name = normalized.split('/').pop() ?? '';

  return normalized.startsWith('.data-test-') ||
    normalized.startsWith('data/test-') ||
    normalized.startsWith('coverage/') ||
    normalized.startsWith('dist/') ||
    normalized.startsWith('node_modules/') ||
    name.endsWith('.log');
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
