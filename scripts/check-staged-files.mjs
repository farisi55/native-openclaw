#!/usr/bin/env node
/**
 * check-staged-files.mjs — rejects staged paths that must never enter git history.
 * Run by .husky/pre-commit; exits 1 and lists every violation, or 0 when the staged set is clean.
 */
import { spawnSync } from 'node:child_process';

const KEY_OR_CERT = /\.(pem|key|p12|pfx|cer|crt|der)$/i;
const SSH_KEY = /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i;
const ALLOWED_ENV_FILES = new Set(['.env.example']);

// Runs git with fixed arguments and returns its stdout, failing loudly when git is unavailable.
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`Unable to run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

// Returns the reason a repository-relative path is denylisted, or null when it is allowed.
function violationReason(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const base = segments[segments.length - 1];

  if (base === '.env' || (base.startsWith('.env.') && !ALLOWED_ENV_FILES.has(base))) {
    return 'environment file that may hold secrets';
  }
  if (KEY_OR_CERT.test(base)) return 'private key or certificate';
  if (SSH_KEY.test(base)) return 'SSH private key';
  if (base === 'CLAUDE.local.md') return 'agent-local instructions';
  if (base === 'settings.local.json' && segments.includes('.claude')) {
    return 'agent-local Claude settings';
  }
  if (segments.includes('.claude') && segments.includes('worktrees')) {
    return 'AI-agent worktree state';
  }
  if (base.startsWith('.aider')) return 'Aider agent state';
  if (segments.includes('.scratch')) return 'scratch file';
  if (segments.includes('secrets')) return 'secret material in a secrets directory';
  return null;
}

const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);

const staged = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD'])
  .split('\0')
  .filter(Boolean);

const violations = staged
  .map((filePath) => ({ filePath, reason: violationReason(filePath) }))
  .filter((entry) => entry.reason !== null);

if (violations.length === 0) {
  process.exit(0);
}

console.error('Commit blocked: staged path(s) may contain secrets or local-only agent state.');
for (const { filePath, reason } of violations) {
  console.error(`  ${filePath} — ${reason}`);
}
console.error('Unstage with: git restore --staged <path>, then retry.');
process.exit(1);
