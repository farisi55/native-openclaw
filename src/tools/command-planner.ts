import { classifyCommandRisk, isDangerousCommand, type CommandRiskAssessment } from './system-execute';

export interface CommandPlanRequest {
  /** Natural language intent, e.g. "list 10 largest files in downloads". */
  intent: string;
  platform: 'win32' | 'linux' | 'darwin';
  shell: string;
}

export interface CommandPlanResult {
  command: string;
  isDangerous: boolean;
  risk?: CommandRiskAssessment;
  requiresApproval?: boolean;
  explanation: string;
}

const COMMAND_TEMPLATES: Record<string, Record<CommandPlanRequest['platform'], string>> = {
  list_downloads_by_size: {
    win32: 'Get-ChildItem -LiteralPath "$env:USERPROFILE\\Downloads" -File -Recurse | Sort-Object Length -Descending | Select-Object -First 10 Name, @{N=\'Size(MB)\';E={[math]::Round($_.Length/1MB,2)}}',
    linux: 'find ~/Downloads -type f -exec ls -la {} \\; | sort -k5 -rn | head -10',
    darwin: 'find ~/Downloads -type f -exec ls -la {} \\; | sort -k5 -rn | head -10',
  },
  count_files_by_extension: {
    win32: '(Get-ChildItem -LiteralPath "$env:USERPROFILE\\Downloads" -Filter *.{EXT} -File -Recurse).Count',
    linux: 'find ~/Downloads -name "*.{EXT}" -type f | wc -l',
    darwin: 'find ~/Downloads -name "*.{EXT}" -type f | wc -l',
  },
};

function inferExtension(intent: string): string {
  const explicit = intent.match(/\b(?:extension|ekstensi|file)\s+\.?([a-z0-9]{1,12})\b/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();

  const dotted = intent.match(/\.([a-z0-9]{1,12})\b/i);
  if (dotted?.[1]) return dotted[1].toLowerCase();

  return '*';
}

/**
 * Placeholder command planner.
 *
 * This intentionally uses deterministic platform-aware heuristics instead of an
 * LLM call so callers can depend on the public interface without creating a
 * circular dependency. A future LLM-backed planner can replace only the internals.
 */
export async function planCommand(request: CommandPlanRequest): Promise<CommandPlanResult> {
  const intent = request.intent.trim();
  const lower = intent.toLowerCase();

  if (isDangerousCommand(intent)) {
    const risk = classifyCommandRisk(intent);
    return {
      command: intent,
      isDangerous: true,
      risk,
      requiresApproval: risk.requiresApproval,
      explanation: 'The requested command matches a dangerous system-operation pattern.',
    };
  }

  if (
    /(largest|biggest|besar|terbesar|size|ukuran)/i.test(lower) &&
    /(download|downloads|unduhan)/i.test(lower)
  ) {
    const command = COMMAND_TEMPLATES['list_downloads_by_size'][request.platform];
    const risk = classifyCommandRisk(command);
    return {
      command,
      isDangerous: risk.risk === 'dangerous',
      risk,
      requiresApproval: risk.requiresApproval,
      explanation: 'Lists the largest files in the Downloads folder using the current platform shell.',
    };
  }

  if (/(count|jumlah|hitung)/i.test(lower) && /(extension|ekstensi|file|\.)/i.test(lower)) {
    const ext = inferExtension(intent);
    const command = COMMAND_TEMPLATES['count_files_by_extension'][request.platform].replace('{EXT}', ext);
    const risk = classifyCommandRisk(command);
    return {
      command,
      isDangerous: risk.risk === 'dangerous',
      risk,
      requiresApproval: risk.requiresApproval,
      explanation: `Counts files with extension "${ext}" in the Downloads folder.`,
    };
  }

  const fallback = request.platform === 'win32'
    ? 'Get-ChildItem -LiteralPath "$env:USERPROFILE\\Downloads"'
    : 'ls -la ~/Downloads';

  const risk = classifyCommandRisk(fallback);
  return {
    command: fallback,
    isDangerous: risk.risk === 'dangerous',
    risk,
    requiresApproval: risk.requiresApproval,
    explanation: `No exact heuristic matched; returning a safe Downloads listing for ${request.shell}.`,
  };
}
