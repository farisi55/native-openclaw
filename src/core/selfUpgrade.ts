import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
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
  const latestVersion = execSync('npm view @openclaw/core version').toString().trim();

  if (!force && currentVersion === latestVersion) {
    return `Already up to date (${currentVersion})`;
  }

  if (dryRun) {
    return `Would upgrade from ${currentVersion} to ${latestVersion}`;
  }

  // Update package.json
  packageJson.dependencies['@openclaw/core'] = latestVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

  // Add marker to prevent circular upgrades
  const mainFilePath = join(process.cwd(), 'src', 'index.ts');
  let mainFileContent = readFileSync(mainFilePath, 'utf-8');
  if (!mainFileContent.includes(SELF_UPGRADE_MARKER)) {
    mainFileContent = `${SELF_UPGRADE_MARKER}\n${mainFileContent}`;
    writeFileSync(mainFilePath, mainFileContent);
  }

  // Install new version
  execSync('npm install', { stdio: 'inherit' });

  return `Successfully upgraded from ${currentVersion} to ${latestVersion}`;
}