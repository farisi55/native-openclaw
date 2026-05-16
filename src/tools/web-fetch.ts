/**
 * tools/web-fetch.ts
 * Internet tool — fetches news headlines or arbitrary URLs.
 *
 * Supported patterns (detected in tool-handler.ts):
 *   "news today" / "what is the news" / "latest news"
 *   "fetch url <url>" / "open url <url>"
 *
 * Uses fetch() natively — no extra dependencies.
 * Newsapi.org fallback: if API key not set, uses open RSS-to-JSON endpoint.
 */

import { createLogger } from '../utils/logger';
import { networkFetch } from '../network';

const logger = createLogger('tool:web-fetch');
const TIMEOUT_MS = 15_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WebFetchResult {
  ok: boolean;
  content: string;
  source: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await networkFetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function truncateText(text: string, maxLen = 1200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…\n[truncated]';
}

// ─── News fetcher ─────────────────────────────────────────────────────────────

async function fetchNews(country = 'us'): Promise<WebFetchResult> {
  const apiKey = process.env['NEWS_API_KEY'];

  // If user has NewsAPI key — use it
  if (apiKey) {
    try {
      const url = `https://newsapi.org/v2/top-headlines?country=${country}&pageSize=8&apiKey=${apiKey}`;
      const res = await fetchWithTimeout(url);
      if (res.ok) {
        const data = await res.json() as { articles?: Array<{ title: string; description?: string; source?: { name: string } }> };
        const lines = (data.articles ?? []).slice(0, 8).map((a, i) =>
          `${i + 1}. **${a.title}** (${a.source?.name ?? 'Unknown'})\n   ${a.description ?? ''}`
        );
        return {
          ok: true,
          content: `📰 **Top Headlines (${country.toUpperCase()}) — NewsAPI**\n\n${lines.join('\n\n')}`,
          source: 'newsapi.org',
        };
      }
    } catch (e) {
      logger.warn('NewsAPI fetch failed, falling back to RSS', { error: String(e) });
    }
  }

  // Fallback: GNews RSS via rss2json public API (no key needed)
  try {
    const rssUrl = encodeURIComponent('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en');
    const url = `https://api.rss2json.com/v1/api.json?rss_url=${rssUrl}&count=8`;
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      const data = await res.json() as { items?: Array<{ title: string; pubDate?: string }> };
      const lines = (data.items ?? []).slice(0, 8).map((a, i) =>
        `${i + 1}. ${a.title}`
      );
      return {
        ok: true,
        content: `📰 **Top Headlines (Google News)**\n\n${lines.join('\n')}`,
        source: 'news.google.com',
      };
    }
  } catch (e) {
    logger.warn('RSS fallback failed', { error: String(e) });
  }

  return {
    ok: false,
    content: '❌ Could not fetch news. Set NEWS_API_KEY in .env for NewsAPI, or check your internet connection.',
    source: 'none',
  };
}

// ─── Generic URL fetch ────────────────────────────────────────────────────────

async function fetchUrl(url: string): Promise<WebFetchResult> {
  try {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    const res = await fetchWithTimeout(url, {
      'User-Agent': 'native-openclaw/5.0 (CLI agent)',
      'Accept': 'text/html,application/json,text/plain',
    });
    if (!res.ok) {
      return { ok: false, content: `❌ HTTP ${res.status} fetching ${url}`, source: url };
    }
    const ct = res.headers.get('content-type') ?? '';
    let text: string;
    if (ct.includes('json')) {
      const json = await res.json();
      text = JSON.stringify(json, null, 2);
    } else {
      text = await res.text();
      // Strip HTML tags for readability
      text = text.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    }
    return {
      ok: true,
      content: truncateText(`🌐 **${url}**\n\n${text}`),
      source: url,
    };
  } catch (e) {
    return {
      ok: false,
      content: `❌ Failed to fetch ${url}: ${String(e)}`,
      source: url,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runWebFetch(input: string): Promise<WebFetchResult> {
  const trimmed = input.trim().toLowerCase();

  // URL fetch
  const urlMatch = /(?:fetch|open|get)\s+url\s+(https?:\/\/\S+|\S+\.\S+)/i.exec(input);
  if (urlMatch?.[1]) {
    logger.debug('web-fetch: URL mode', { url: urlMatch[1] });
    return fetchUrl(urlMatch[1]);
  }

  // Country-specific news
  const countryMatch = /news\s+(?:from\s+|in\s+)?(\w{2,3})$/i.exec(trimmed);
  if (countryMatch?.[1]) {
    logger.debug('web-fetch: news by country', { country: countryMatch[1] });
    return fetchNews(countryMatch[1].toLowerCase());
  }

  // Default: US news
  logger.debug('web-fetch: default news');
  return fetchNews('us');
}
