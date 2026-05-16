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

function manager(): WorkspaceManager {
  return new WorkspaceManager();
}

export async function workspaceList(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? '.';
  const entries = await manager().list(path);
  const lines = entries.map((entry) => `${entry.type === 'directory' ? '[dir] ' : '[file]'} ${entry.path}`);
  return {
    ok: true,
    content: lines.length > 0 ? lines.join('\n') : '(empty)',
  };
}

export async function workspaceRead(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  if (!path) throw new Error('workspace-read requires "path".');
  return {
    ok: true,
    content: await manager().read(path),
  };
}

export async function workspaceWrite(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'file');
  const content = getString(input, 'content') ?? getString(input, 'text');
  if (!path) throw new Error('workspace-write requires "path".');
  if (content === undefined) throw new Error('workspace-write requires "content".');
  await manager().write(path, content);
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
  await manager().append(path, content);
  return {
    ok: true,
    content: `Appended to workspace file: ${path}`,
  };
}

export async function workspaceMkdir(input: unknown): Promise<WorkspaceToolResult> {
  const path = getString(input, 'path') ?? getString(input, 'folder');
  if (!path) throw new Error('workspace-mkdir requires "path".');
  await manager().mkdir(path);
  return {
    ok: true,
    content: `Created workspace folder: ${path}`,
  };
}

