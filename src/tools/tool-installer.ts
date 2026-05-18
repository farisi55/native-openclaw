/**
 * tools/tool-installer.ts
 * Copies a tool from tools/available/<name>/ → tools/installed/<name>/
 * No internet download — purely local filesystem.
 */

import { readdir, mkdir, copyFile, rm } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger';

const logger = createLogger('tools:installer');

export interface InstallResult {
  ok: boolean;
  message: string;
}

export async function installTool(
  name: string,
  projectRoot?: string
): Promise<InstallResult> {
  const root = projectRoot ?? process.cwd();
  const availableDir = join(root, 'tools', 'available', name);
  const installedDir = join(root, 'tools', 'installed', name);

  if (!existsSync(availableDir)) {
    return {
      ok: false,
      message: `Tool "${name}" not found in tools/available/. Available tools: ${listAvailable(root).join(', ')}`,
    };
  }

  const manifestPath = join(availableDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { ok: false, message: `Tool "${name}" is missing manifest.json` };
  }

  if (existsSync(join(installedDir, 'manifest.json'))) {
    return { ok: false, message: `Tool "${name}" is already installed. Use /tools enable ${name} to re-enable it.` };
  }

  await mkdir(installedDir, { recursive: true });

  let files: string[];
  try {
    files = await readdir(availableDir);
  } catch (e) {
    return { ok: false, message: `Cannot read tools/available/${name}: ${String(e)}` };
  }

  for (const file of files) {
    await copyFile(join(availableDir, file), join(installedDir, file));
  }

  logger.info('tool installed', { name, files });
  return { ok: true, message: `Tool "${name}" installed successfully.` };
}

export async function uninstallTool(
  name: string,
  projectRoot?: string
): Promise<InstallResult> {
  const root = projectRoot ?? process.cwd();
  const installedDir = join(root, 'tools', 'installed', name);

  if (!existsSync(installedDir)) {
    return { ok: false, message: `Tool "${name}" is not installed.` };
  }

  await rm(installedDir, { recursive: true, force: true });
  logger.info('tool uninstalled', { name });
  return { ok: true, message: `Tool "${name}" uninstalled.` };
}

// FIX: use top-level readdirSync import, no inline require
export function listAvailable(projectRoot?: string): string[] {
  const root = projectRoot ?? process.cwd();
  const dir = join(root, 'tools', 'available');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((d: string) =>
      existsSync(join(dir, d, 'manifest.json'))
    );
  } catch {
    return [];
  }
}
