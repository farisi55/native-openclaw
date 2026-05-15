/**
 * tools/browsing.ts
 * Unified browsing layer with Tavily → Firecrawl automatic fallback.
 *
 * Env vars:
 *   TAVILY_API_KEY       — Tavily Search API key
 *   FIRECRAWL_API_KEY    — Firecrawl API key
 *   BROWSING_TIMEOUT_MS  — Request timeout (default: 15000)
 *   BROWSING_MAX_RESULTS — Max results to return (default: 5)
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('tool:browsing');

const TIMEOUT_MS = parseInt(process.env['BROWSING_TIMEOUT_MS'] ?? '15000', 10);
const MAX_RESULTS = parseInt(process.env['BROWSING_MAX_RESULTS'] ?? '5', 10);

// ─── Unified result type ──────────────────────────────────────────────────────

export interface BrowsingResult {
  ok: boolean;
  source: 'tavily' | 'firecrawl' | 'none';
  results: BrowsingItem[];
  error?: string;
}

export interface BrowsingItem {
  title: string;
  url: string;
  snippet: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

function isEmptyResults(items: BrowsingItem[]): boolean {
  return items.length === 0 || items.every((i) => !i.title && !i.snippet && !i.content);
}

function cleanMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const cleaned = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined)
  );

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ─── Tavily ───────────────────────────────────────────────────────────────────

async function searchTavily(query: string): Promise<BrowsingResult> {
  const apiKey = process.env['TAVILY_API_KEY'];

  if (!apiKey) {
    throw new Error('TAVILY_API_KEY not set');
  }

  const res = await fetchWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (res.status === 429) {
    throw new Error('Tavily rate-limited (429)');
  }

  if (!res.ok) {
    throw new Error(`Tavily HTTP ${res.status}`);
  }

  const data = await res.json() as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      snippet?: string;
      score?: number;
      published_date?: string;
    }>;
  };

  const items: BrowsingItem[] = (data.results ?? [])
    .slice(0, MAX_RESULTS)
    .map((r) => {
      const metadata = cleanMetadata({
        score: r.score,
        published_date: r.published_date,
      });

      const item: BrowsingItem = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? r.content?.slice(0, 200) ?? '',
        content: r.content ?? '',
      };

      if (metadata) {
        item.metadata = metadata;
      }

      return item;
    });

  if (isEmptyResults(items)) {
    throw new Error('Tavily returned empty results');
  }

  return {
    ok: true,
    source: 'tavily',
    results: items,
  };
}

// ─── Firecrawl ────────────────────────────────────────────────────────────────

async function searchFirecrawl(query: string): Promise<BrowsingResult> {
  const apiKey = process.env['FIRECRAWL_API_KEY'];

  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY not set');
  }

  const res = await fetchWithTimeout('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: MAX_RESULTS,
    }),
  });

  if (res.status === 429) {
    throw new Error('Firecrawl rate-limited (429)');
  }

  if (!res.ok) {
    throw new Error(`Firecrawl HTTP ${res.status}`);
  }

  const data = await res.json() as {
    data?: Array<{
      title?: string;
      url?: string;
      description?: string;
      markdown?: string;
      metadata?: Record<string, unknown>;
    }>;
  };

  const items: BrowsingItem[] = (data.data ?? [])
    .slice(0, MAX_RESULTS)
    .map((r) => {
      const item: BrowsingItem = {
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? r.markdown?.slice(0, 200) ?? '',
        content: r.markdown ?? r.description ?? '',
      };

      if (r.metadata) {
        item.metadata = r.metadata;
      }

      return item;
    });

  if (isEmptyResults(items)) {
    throw new Error('Firecrawl returned empty results');
  }

  return {
    ok: true,
    source: 'firecrawl',
    results: items,
  };
}

// ─── Public API with Tavily → Firecrawl fallback ──────────────────────────────

export async function browse(query: string): Promise<BrowsingResult> {
  if (process.env['TAVILY_API_KEY']) {
    try {
      logger.debug('browsing: trying Tavily', {
        query: query.slice(0, 60),
      });

      const result = await searchTavily(query);

      logger.info('browsing: Tavily succeeded', {
        results: result.results.length,
      });

      return result;
    } catch (e) {
      logger.warn('browsing: Tavily failed — falling back to Firecrawl', {
        error: String(e),
      });
    }
  }

  if (process.env['FIRECRAWL_API_KEY']) {
    try {
      logger.debug('browsing: trying Firecrawl', {
        query: query.slice(0, 60),
      });

      const result = await searchFirecrawl(query);

      logger.info('browsing: Firecrawl succeeded', {
        results: result.results.length,
      });

      return result;
    } catch (e) {
      logger.warn('browsing: Firecrawl also failed', {
        error: String(e),
      });

      return {
        ok: false,
        source: 'none',
        results: [],
        error: String(e),
      };
    }
  }

  logger.warn('browsing: no API keys configured');

  return {
    ok: false,
    source: 'none',
    results: [],
    error: 'No browsing API keys configured. Set TAVILY_API_KEY or FIRECRAWL_API_KEY.',
  };
}

/**
 * Format browsing results as a readable string for LLM injection.
 */
export function formatBrowsingResults(result: BrowsingResult, query: string): string {
  if (!result.ok || result.results.length === 0) {
    return `🔍 Web search for "${query}" returned no results. ${result.error ?? ''}`;
  }

  const lines = [
    `🔍 **Web Search Results** (via ${result.source}) — "${query}"`,
    '',
  ];

  result.results.forEach((r, i) => {
    lines.push(`**${i + 1}. ${r.title}**`);
    lines.push(`URL: ${r.url}`);

    if (r.snippet) {
      lines.push(r.snippet);
    }

    lines.push('');
  });

  return lines.join('\n');
}