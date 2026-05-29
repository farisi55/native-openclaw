import { extname, isAbsolute, normalize, relative, resolve, sep } from 'path';

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
]);

const BLOCKED_SEGMENTS = new Set(['node_modules', 'dist', '.git']);
const BLOCKED_BASENAMES = new Set(['id_rsa']);

export class SafetyPolicy {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  resolveInsideRoot(filePath: string): string {
    const target = isAbsolute(filePath) ? normalize(filePath) : resolve(this.rootDir, filePath);
    const rel = relative(this.rootDir, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Unsafe path outside repository: ${filePath}`);
    }
    return target;
  }

  relativePath(filePath: string): string {
    const target = this.resolveInsideRoot(filePath);
    return relative(this.rootDir, target).split(sep).join('/');
  }

  assertSafeFilePath(filePath: string): string {
    const target = this.resolveInsideRoot(filePath);
    const rel = relative(this.rootDir, target);
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    const basename = parts[parts.length - 1] ?? '';
    const ext = extname(basename).toLowerCase();

    if (parts.some((part) => BLOCKED_SEGMENTS.has(part))) {
      throw new Error(`Blocked unsafe path segment: ${filePath}`);
    }
    if (basename === '.env' || basename.startsWith('.env.') || BLOCKED_BASENAMES.has(basename)) {
      throw new Error(`Blocked secret file: ${filePath}`);
    }
    if (basename.endsWith('.pem') || basename.endsWith('.key') || basename.startsWith('secrets.')) {
      throw new Error(`Blocked secret file: ${filePath}`);
    }
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`Blocked unsupported file extension: ${filePath}`);
    }

    return target;
  }

  assertAllowedCommand(command: string): void {
    const trimmed = command.trim();
    if (trimmed === 'npm run build' || trimmed === 'npm test' || trimmed === 'npm run test') return;

    const install = /^npm\s+install\s+(@?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)?)(?:\s+--save(?:-dev)?)?$/i.exec(trimmed);
    if (!install?.[1] || !SafetyPolicy.isSafePackageName(install[1])) {
      throw new Error(`Command is not allowed: ${command}`);
    }
  }

  static isSafePackageName(name: string): boolean {
    if (!/^(@[a-z0-9-_.]+\/[a-z0-9-_.]+|[a-z0-9-_.]+)$/i.test(name)) return false;
    return !/[;&|<>$`\s]/.test(name);
  }
}
