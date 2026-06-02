const COMMON_NOUN_USER_NAMES = new Set([
  'admin',
  'arsenal',
  'berita',
  'boss',
  'client',
  'cronjob',
  'download',
  'email',
  'emas',
  'file',
  'folder',
  'harga',
  'laporan',
  'meeting',
  'pengguna',
  'reminder',
  'report',
  'telegram',
  'user',
]);

const LETTER_NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ]+){0,3}$/;

export function normalizeUserNameCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/^["'`]+|["'`.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!isValidUserName(cleaned)) return null;

  if (cleaned === cleaned.toLowerCase()) {
    return cleaned
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  return cleaned;
}

export function isValidUserName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value
    .replace(/^["'`]+|["'`.,!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (!LETTER_NAME_RE.test(trimmed)) return false;

  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (words.some((word) => COMMON_NOUN_USER_NAMES.has(word))) return false;

  return true;
}
