import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SELF_UPGRADE_MARKER = '// @openclaw/self-upgrade-marker';

interface SelfUpgradeOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function performSelfUpgrade(options: SelfUpgradeOptions = {}): Promise<string> {
  const { dryRun = false, force = false } = options;
  const packageJsonPath = join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

  if (!packageJson.dependencies?.['@openclaw/core']) {
    throw new Error('Cannot perform self-upgrade: @openclaw/core not found in dependencies');
  }

  const currentVersion = packageJson.dependencies['@openclaw/core'];
  let latestVersion: string;
  try {
    latestVersion = execSync('npm view @openclaw/core version').toString().trim();
  } catch {
    return 'Could not fetch latest @openclaw/core version from npm registry.';
  }

  if (!force && currentVersion === latestVersion) {
    return `Already up to date (${currentVersion})`;
  }

  if (dryRun) {
    return `Would upgrade from ${currentVersion} to ${latestVersion}`;
  }

  const mainFilePath = join(process.cwd(), 'src', 'index.ts');
  if (!existsSync(mainFilePath)) {
    return 'Could not perform self-upgrade: src/index.ts was not found.';
  }

  // Update package.json
  packageJson.dependencies['@openclaw/core'] = latestVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  // Add marker to prevent circular upgrades
  let mainFileContent = readFileSync(mainFilePath, 'utf-8');
  if (!mainFileContent.includes(SELF_UPGRADE_MARKER)) {
    mainFileContent = `${SELF_UPGRADE_MARKER}\n${mainFileContent}`;
    writeFileSync(mainFilePath, mainFileContent);
  }

  // Install new version
  execSync('npm install', { stdio: 'inherit' });

  return `Successfully upgraded from ${currentVersion} to ${latestVersion}`;
}
