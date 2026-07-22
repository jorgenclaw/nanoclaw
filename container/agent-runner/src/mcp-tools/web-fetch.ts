/**
 * MCP tool: fetch a URL and return readable text.
 *
 * Bridge for smaller models that don't grok agent-browser's two-step pattern
 * (open → snapshot). This does HTTP GET + HTML-to-text conversion in one call.
 * For JS-heavy pages that need actual rendering, fall back to agent-browser.
 *
 * Strips <script>, <style>, <nav>, <footer>; collapses whitespace. Truncates
 * to 8000 chars (configurable) so the model can actually reason about it.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { registerTools } from './server.js';

const execFileAsync = promisify(execFile);

const MAX_CHARS_DEFAULT = 8000;

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

registerTools([
  {
    tool: {
      name: 'web_fetch',
      description:
        'Fetch a URL and return its readable text (HTML stripped, scripts/styles removed, whitespace collapsed). ' +
        'Single-call alternative to agent-browser open + snapshot for static pages and APIs. ' +
        'Returns up to ~8000 characters of plain text. For JS-rendered SPAs use agent-browser.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Absolute URL (http/https)' },
          maxChars: {
            type: 'number',
            description: `Max characters of body to return (default ${MAX_CHARS_DEFAULT}, max 32000)`,
          },
        },
        required: ['url'],
      },
    },
    async handler(args) {
      const { url, maxChars } = args as { url: string; maxChars?: number };
      if (!/^https?:\/\//i.test(url)) {
        return {
          content: [{ type: 'text' as const, text: `Invalid URL (must start with http/https): ${url}` }],
          isError: true,
        };
      }
      const limit = Math.min(Math.max(maxChars ?? MAX_CHARS_DEFAULT, 200), 32000);
      try {
        const { stdout } = await execFileAsync(
          'curl',
          [
            '-fsSL',
            '--max-time',
            '20',
            '-A',
            'Mozilla/5.0 (compatible; NanoClawAgent/1.0)',
            '-H',
            'Accept: text/html,application/json,text/plain,*/*',
            url,
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        const isJson = stdout.trim().startsWith('{') || stdout.trim().startsWith('[');
        const text = isJson ? stdout : htmlToText(stdout);
        const truncated = text.length > limit;
        const body = truncated ? text.slice(0, limit) + `\n\n[... truncated, ${text.length - limit} chars omitted ...]` : text;
        return {
          content: [
            {
              type: 'text' as const,
              text: `URL: ${url}\nFormat: ${isJson ? 'json' : 'text'}\nLength: ${text.length} chars${truncated ? ` (truncated to ${limit})` : ''}\n\n${body}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  },
]);
