/**
 * Plugin entry for web-fetch tool.
 * Uses Tavily→Firecrawl browsing layer when keys are configured,
 * falls back to the original RSS-based implementation.
 */
import { browse, formatBrowsingResults } from '../browsing';
import { runWebFetch } from '../web-fetch';

export async function run(input: { query: string } | Record<string, string>): Promise<string> {
  const query = typeof input === 'string' ? input : (input.query ?? String(input));

  // Use Tavily/Firecrawl if configured
  if (process.env['TAVILY_API_KEY'] || process.env['FIRECRAWL_API_KEY']) {
    const result = await browse(query);
    return formatBrowsingResults(result, query);
  }

  // Legacy RSS fallback
  const result = await runWebFetch(query);
  return result.content;
}