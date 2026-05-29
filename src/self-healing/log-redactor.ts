const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/\b(api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s,}]+/gi, '$1=[REDACTED]'],
  [/\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s]+/g, '[REDACTED_ENV_SECRET]'],
  [/(https?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1[REDACTED]$3'],
  [/\b(?:sk|pk|rk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
];

export function redactSecrets(input: string, enabled = true): string {
  if (!enabled || !input) return input;
  return SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input
  );
}

export function truncateForReport(input: string, maxLength = 6000): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n...[truncated]`;
}
