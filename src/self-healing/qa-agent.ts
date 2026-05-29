import type { CommandRunResult, QAReport } from './healing-types';
import { truncateForReport } from './log-redactor';

function packageNameFromImport(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return null;
  }
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return specifier.split('/')[0] ?? null;
}

export class QAAgent {
  analyze(commands: CommandRunResult[]): QAReport {
    const failed = commands.find((result) => result.exitCode !== 0 || result.timedOut);
    const rawLog = commands
      .map((result) => [
        `$ ${result.command}`,
        result.stdout,
        result.stderr,
        `exit=${result.exitCode} durationMs=${result.durationMs} timedOut=${result.timedOut}`,
      ].join('\n'))
      .join('\n\n');

    if (!failed) {
      return {
        passed: true,
        summary: 'All configured QA commands passed.',
        missingPackages: [],
        errors: [],
        nextAction: 'done',
        rawLogExcerpt: truncateForReport(rawLog),
      };
    }

    const missingPackages = this.detectMissingPackages(rawLog);
    const errors = this.extractErrors(rawLog);
    const failedCommand = failed.command;

    return {
      passed: false,
      summary: missingPackages.length > 0
        ? `Missing package(s): ${missingPackages.join(', ')}`
        : `${failedCommand} failed.`,
      failedCommand,
      missingPackages,
      errors,
      nextAction: missingPackages.length > 0 ? 'install_dependency' : 'retry_fix',
      rawLogExcerpt: truncateForReport(rawLog),
    };
  }

  private detectMissingPackages(log: string): string[] {
    const patterns = [
      /Cannot find module ['"]([^'"]+)['"]/g,
      /Cannot find package ['"]([^'"]+)['"]/g,
      /Module not found: Can't resolve ['"]([^'"]+)['"]/g,
      /ERR_MODULE_NOT_FOUND[\s\S]{0,160}?['"]([^'"]+)['"]/g,
      /TS2307:[^\n]*Cannot find module ['"]([^'"]+)['"]/g,
    ];

    const packages = new Set<string>();
    for (const pattern of patterns) {
      for (const match of log.matchAll(pattern)) {
        const pkg = packageNameFromImport(match[1] ?? '');
        if (pkg) packages.add(pkg);
      }
    }
    return [...packages].sort();
  }

  private extractErrors(log: string): string[] {
    return log
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /error|failed|Cannot find|ERR_|not ok|AssertionError|TS\d+/i.test(line)
      )
      .slice(0, 20);
  }
}
