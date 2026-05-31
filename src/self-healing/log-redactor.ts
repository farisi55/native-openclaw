const REDACTED = '[REDACTED]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';

const URL_CREDENTIAL_RE = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KNOWN_TOKEN_RE = /\b(?:sk|pk|rk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{8,}\b/g;
const BREVO_TOKEN_RE = /\bxkeysib-[A-Za-z0-9_-]{12,}\b/gi;
const GROQ_TOKEN_RE = /\bgsk_[A-Za-z0-9_-]{12,}\b/gi;
const TAVILY_TOKEN_RE = /\btvly-[A-Za-z0-9_-]{12,}\b/gi;
const FIRECRAWL_TOKEN_RE = /\bfc-[A-Za-z0-9_-]{12,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b((?:[A-Za-z_][A-Za-z0-9_-]*)?(?:api[_-]?key|token|secret|password|passwd|pwd)[A-Za-z0-9_-]*)\b(\s*[:=]\s*)(["'`]?)([^"'`\s,;}]+)(["'`]?)/gi;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isBooleanNumberOrNullish(value: string): boolean {
  return /^(?:true|false|null|undefined|nan|infinity|-?\d+(?:\.\d+)?)$/i.test(value);
}

function isSimpleIdentifierReference(value: string): boolean {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value)) {
    return false;
  }
  if (value.includes('.')) return true;
  if (/^(?:token|accessToken|password|passwd|pwd|apiKey|secret|key)$/i.test(value)) return true;
  return !/\d/.test(value);
}

function hasHighEntropyShape(value: string): boolean {
  if (value.length < 20) return false;
  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[_+/=.:-]/.test(value),
  ].filter(Boolean).length;
  const uniqueChars = new Set(value).size;
  return classes >= 3 || uniqueChars >= 12;
}

export function looksLikeSecret(value: string): boolean {
  const cleaned = unquote(value).replace(/[;,.]+$/, '').trim();
  if (!cleaned) return false;
  if (isBooleanNumberOrNullish(cleaned)) return false;
  if (isSimpleIdentifierReference(cleaned)) return false;
  if (URL_CREDENTIAL_RE.test(cleaned)) {
    URL_CREDENTIAL_RE.lastIndex = 0;
    return true;
  }
  URL_CREDENTIAL_RE.lastIndex = 0;

  if (/^(?:sk|pk|rk|ghp|glpat|xoxb|xoxp)-[A-Za-z0-9_-]{4,}$/i.test(cleaned)) return true;
  if (/^sk-proj-[A-Za-z0-9_-]+$/i.test(cleaned)) return true;
  if (/^xkeysib-[A-Za-z0-9_-]{8,}$/i.test(cleaned)) return true;
  if (/^gsk_[A-Za-z0-9_-]{8,}$/i.test(cleaned)) return true;
  if (/^tvly-[A-Za-z0-9_-]{8,}$/i.test(cleaned)) return true;
  if (/^fc-[A-Za-z0-9_-]{8,}$/i.test(cleaned)) return true;
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cleaned)) return true;
  if (/secret|password|passwd/i.test(cleaned) && cleaned.length >= 8) return true;
  if (hasHighEntropyShape(cleaned)) return true;

  return false;
}

function redactSecretAssignment(match: string, key: string, separator: string, quote: string, value: string, closingQuote: string): string {
  if (!looksLikeSecret(value)) return match;
  const safeClosingQuote = quote ? (closingQuote || quote) : '';
  return `${key}${separator}${quote}${REDACTED}${safeClosingQuote}`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [BEARER_RE, `Bearer ${REDACTED}`],
  [URL_CREDENTIAL_RE, `$1${REDACTED}$3`],
  [KNOWN_TOKEN_RE, REDACTED_TOKEN],
  [BREVO_TOKEN_RE, REDACTED_TOKEN],
  [GROQ_TOKEN_RE, REDACTED_TOKEN],
  [TAVILY_TOKEN_RE, REDACTED_TOKEN],
  [FIRECRAWL_TOKEN_RE, REDACTED_TOKEN],
  [JWT_RE, REDACTED_TOKEN],
];

export function redactSecrets(input: string, enabled = true): string {
  if (!enabled || !input) return input;
  const patternRedacted = SECRET_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    input
  );
  return patternRedacted.replace(SECRET_ASSIGNMENT_RE, redactSecretAssignment);
}

export function truncateForReport(input: string, maxLength = 6000): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength)}\n...[truncated]`;
}
