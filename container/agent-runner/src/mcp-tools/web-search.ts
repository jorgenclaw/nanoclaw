/**
 * MCP tool: web search via DuckDuckGo HTML interface.
 *
 * Returns a list of {title, url, snippet} results. No API key. Replaces the
 * "open google.com/search?q=..." pattern that doom-loops smaller models —
 * they get back JSON results in one call instead of a navigation status code.
 *
 * Uses the html.duckduckgo.com fallback (no JS required) and parses the
 * results from the rendered HTML. Best-effort — DDG's markup occasionally
 * shifts, in which case we fall back to returning the raw text.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { registerTools } from './server.js';

const execFileAsync = promisify(execFile);

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlockRe =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = resultBlockRe.exec(html)) !== null) {
    if (results.length >= limit) break;
    const rawUrl = match[1];
    let url = rawUrl;
    const ddgRedirect = url.match(/^\/\/duckduckgo\.com\/l\/\?uddg=([^&]+)/);
    if (ddgRedirect) {
      try {
        url = decodeURIComponent(ddgRedirect[1]);
      } catch {
        // keep raw
      }
    } else if (url.startsWith('//')) {
      url = `https:${url}`;
    }
    const stripTags = (s: string): string =>
      s
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    results.push({
      title: stripTags(match[2]),
      url,
      snippet: stripTags(match[3]),
    });
  }
  return results;
}

registerTools([
  {
    tool: {
      name: 'web_search',
      description:
        'Search the web (DuckDuckGo HTML, no API key). Returns up to 10 results as ' +
        '{title, url, snippet}. Use this instead of `agent-browser open google.com/search?q=...` — ' +
        'that pattern only returns a navigation status code and dooms small models to retry loops.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: {
            type: 'number',
            description: 'Max results to return (default 5, max 10)',
          },
        },
        required: ['query'],
      },
    },
    async handler(args) {
      const { query, limit } = args as { query: string; limit?: number };
      const max = Math.min(Math.max(limit ?? 5, 1), 10);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      try {
        const { stdout } = await execFileAsync(
          'curl',
          [
            '-fsSL',
            '--max-time',
            '15',
            '-A',
            'Mozilla/5.0 (compatible; NanoClawAgent/1.0)',
            url,
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        );
        const results = parseDuckDuckGoHtml(stdout, max);
        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No parsable results for "${query}". DuckDuckGo HTML may have changed; try web_fetch on a specific URL instead.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ query, count: results.length, results }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Search failed for "${query}": ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  },
]);
