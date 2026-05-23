/**
 * workspace/workspace-tools.ts
 * Tool-facing wrappers around WorkspaceManager.
 */

import { WorkspaceManager } from './workspace-manager';

export interface WorkspaceToolResult {
  ok: boolean;
  content: string;
}

function getString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

let _manager: WorkspaceManager | undefined;

function getManager(): WorkspaceManager {
  if (!_manager) _manager = new WorkspaceManager();
  return _manager;
}

export function resetManagerForTesting(): void {
  _manager = undefined;
}

export async function workspaceList(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? '.';
  const entries = await getManager().list(path);
  const lines = entries.map((entry) => `${entry.type === 'directory' ? '[dir] ' : '[file]'} ${entry.path}`);
  return {
    ok: true,
    content: lines.length > 0 ? lines.join('\n') : '(empty)',
  };
}

export async function workspaceTree(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? '.';
  const depthText = getString(input, 'maxDepth');
  const maxDepth = depthText ? Number.parseInt(depthText, 10) : 3;
  return {
    ok: true,
    content: await getManager().tree(path, Number.isFinite(maxDepth) ? maxDepth : 3),
  };
}

export async function workspaceRead(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  if (!path) throw new Error('workspace-read requires "path".');
  return {
    ok: true,
    content: await getManager().read(path),
  };
}

export async function workspaceTrash(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  if (!path) throw new Error('workspace-trash requires "path".');
  const trashPath = await getManager().trash(path);
  return {
    ok: true,
    content: `Moved workspace path to trash: ${trashPath}`,
  };
}

export async function workspaceBackup(_input: unknown): Promise<WorkspaceToolResult> {
  const backupPath = await getManager().backup();
  return {
    ok: true,
    content: `Created workspace backup: ${backupPath}`,
  };
}

export async function workspaceInfo(_input: unknown): Promise<WorkspaceToolResult> {
  const info = await getManager().info();
  const core = info.coreFiles
    .map((entry) => `${entry.exists ? '[ok] ' : '[missing]'} ${entry.path}`)
    .join('\n');
  return {
    ok: true,
    content: [
      `Root: ${info.rootDir}`,
      `Files: ${info.fileCount}`,
      `Directories: ${info.directoryCount}`,
      `Size: ${info.totalBytes} bytes`,
      '',
      'Core files:',
      core,
    ].join('\n'),
  };
}

export async function workspaceWrite(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  const content = getString(input, 'content') ?? getString(input, 'text');
  if (!path) throw new Error('workspace-write requires "path".');
  if (content === undefined) throw new Error('workspace-write requires "content".');
  await getManager().write(path, content);
  return {
    ok: true,
    content: `Wrote workspace file: ${path}`,
  };
}

export async function workspaceAppend(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  const content = getString(input, 'content') ?? getString(input, 'text');
  if (!path) throw new Error('workspace-append requires "path".');
  if (content === undefined) throw new Error('workspace-append requires "content".');
  await getManager().append(path, content);
  return {
    ok: true,
    content: `Appended to workspace file: ${path}`,
  };
}

export async function workspaceMkdir(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'folder');
  if (!path) throw new Error('workspace-mkdir requires "path".');
  await getManager().mkdir(path);
  return {
    ok: true,
    content: `Created workspace folder: ${path}`,
  };
}
