export const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'a',
  'span',
  'div',
  'blockquote',
  'pre',
  'code',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
]);

export const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title', 'target']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
  '*': new Set(['style', 'class']),
};

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
const BLOCKED_RAW_TEXT_TAG_RE = /<(script|style|iframe|object|embed)\b[^>]*>[^]*?<\/\1>/gi;
const EVENT_HANDLER_ATTR_RE = /\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const DANGEROUS_URI_ATTR_RE = /(href|src)\s*=\s*["']\s*(javascript:|data:)[^"']*["']/gi;

export function sanitizeHtml(input: string): string {
  return input
    .replace(BLOCKED_RAW_TEXT_TAG_RE, '')
    .replace(TAG_RE, (tag, tagName: string) => {
      if (!ALLOWED_TAGS.has(tagName.toLowerCase())) return '';
      return tag
        .replace(EVENT_HANDLER_ATTR_RE, '')
        .replace(DANGEROUS_URI_ATTR_RE, (_match, attr: string) => `${attr}="#removed"`);
    });
}

export default sanitizeHtml;
