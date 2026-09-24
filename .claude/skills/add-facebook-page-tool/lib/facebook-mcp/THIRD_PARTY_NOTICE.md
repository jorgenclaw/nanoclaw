# Third-party notice

This directory is vendored from [`lmtNoLimit/mcp-facebook`](https://github.com/lmtNoLimit/mcp-facebook)
(npm: `@m8lab/mcp-facebook`), commit as of 2026-09-21, MIT licensed.

```
MIT License

Copyright (c) 2026 M8Lab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Why vendored instead of installed as a dependency

Audited 2026-09-21 against 4 other Facebook/Meta Graph API MCP candidates
(full comparison in `groups/main/memory/plans/facebook-page-automation-2026-09-21.md`).
This one was the smallest (597 LOC), had the cleanest license, the fewest and
most appropriate runtime dependencies, and the simplest auth pattern of the
group. We own this code now — it will not receive upstream updates
automatically, and changes to Meta's Graph API (deprecated metrics, new
endpoints) need to be applied here by hand.

## Changes made from upstream

1. **`client.ts`** — moved the Page access token from the `access_token` URL
   query parameter to an `Authorization: Bearer` header. The query-string
   form leaks the token into any logging/proxying layer that records URLs,
   and doesn't work with NanoClaw's OneCLI credential-injection model (the
   gateway rewrites the `Authorization` header in flight; it doesn't rewrite
   query strings).
2. **`client.ts`** — wired in `utils/rate-limiter.ts`, which upstream shipped
   but never actually used anywhere (dead code in the original repo). Now
   caps write actions (POST/DELETE) at `FACEBOOK_MAX_WRITES_PER_HOUR`
   (default 20/hour) as a safety net against a runaway or looping agent.
3. **`utils/error-handler.ts`** — stopped echoing `err.stack` into the tool
   result returned to the model on failure. Not a secret leak, but
   unnecessary noise and minor information disclosure.
4. **`index.ts`** — dropped the `#!/usr/bin/env node` shebang (irrelevant —
   this runs via `bun run`, never executed directly) and the `dotenv/config`
   import (NanoClaw passes env vars through `container_configs.mcp_servers`,
   not a `.env` file next to this script).
5. Dropped `package.json`, `package-lock.json`, `tsconfig.json`, and the
   `bin`/`dist` npm-publishing scaffolding entirely — this isn't published or
   built, it runs as plain TypeScript directly via Bun from NanoClaw's
   already-installed `@modelcontextprotocol/sdk` / `zod` (see
   `container/agent-runner/package.json`).
6. **`client.ts`** — added `FACEBOOK_PAGE_ACCESS_TOKEN_FILE`: read the token
   from a file instead of the env var. Needed when one agent manages several
   Pages — Meta issues a separate Page token per Page, and OneCLI (which
   picks a secret by host/path) can't tell them apart because comment IDs
   don't include the Page ID.
7. **`utils/label-tools.ts`** (new) + **`index.ts`** — added
   `FACEBOOK_PAGE_LABEL`: prefixes every tool description with
   `[Page: <label>]` so an agent with one server per Page knows which Page
   each tool acts on.

## Known limitation carried over from upstream

`facebook_create_post`'s `picture` argument only accepts a URL to an
already-public image (Graph API's `/feed?picture=` shares a hosted image, it
does not upload one). There is no local-file binary upload
(`POST /{page-id}/photos` with multipart form data) — upstream never
implemented it and this vendor pass didn't add it. If posting images that
don't already have a public URL turns out to matter, that's a real follow-up,
not something silently handled today.
