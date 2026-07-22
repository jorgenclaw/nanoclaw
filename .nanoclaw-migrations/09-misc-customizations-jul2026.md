# 09 — Misc Customizations (X-integration, Signal, Moltbook, Wiki, AGENTS.md, Scripts)

Small customizations landed since `757471f4`, unrelated to Passport or agent-runner reliability.

## X-Integration: x_delete_tweet safety guard

**Status:** Added in commit `a4867874`.

The `x_delete_tweet` tool was added with a built-in **text-echo safety guard** instead of an approval gate. Before deletion, the agent must pass `text_must_match` — a substring (≥5 chars) of the actual tweet body. The host script reads the live tweet and refuses to delete if the substring isn't found. Guards against URL hallucinations and copy-paste errors without an approval round-trip.

**Implementation:**
- **MCP tool** (`agent.ts`): `xDeleteTweet` accepts `tweet_url` and `text_must_match` (required, ≥5 chars). Description prompts the agent to always read the tweet first before calling delete.
- **Host handler** (`host.ts`): Registers `x_delete_tweet` action, passes both parameters through.
- **Script logic** (`delete-tweet.ts`, lines 42–72):
  ```typescript
  const actualText = (await article.locator(X_SELECTORS.tweetText).first().innerText()).trim();
  if (!actualText.toLowerCase().includes(expected)) {
    return { success: false, message: `Safety guard: actual tweet body does not contain expected substring...` };
  }
  ```
- **Selectors** (`locators.ts`): Added `caret` (three-dot menu button on tweet card) and `dropdownMenuItem` to open the action menu.

**SKILL.md note:** Changed from "there is no `x_delete_tweet` by design" (defense in depth) to documenting the tool with its safety guard mechanism.

## Signal: UUID-stable routing fix

**Status:** Fixed in commit `e54cab8f`.

signal-cli 0.14.x began populating `source`/`sourceNumber` with phone numbers even for contacts with phone-number privacy enabled; earlier versions put the Account Identifier (UUID) in `source`. NanoClaw groups are registered under the UUID, so routing must key on the stable `sourceUuid` field when available.

**What broke:** Messages from phone-number-privacy contacts routed to the wrong sender identity, and some messages may not have matched any registered group at all.

**Code change** (`signal.ts`, line 332–338):
```typescript
// Prefer the stable ACI (sourceUuid) as the routing key. signal-cli 0.14.x
// began populating `source`/`sourceNumber` with the phone number even for
// contacts with phone-number privacy on; earlier versions put the UUID in
// `source`. Messaging groups are registered under the UUID, so key on it.
const senderId = envelope.sourceUuid || envelope.source || envelope.sourceNumber || '';
```

**Bundled in the same commit:** concurrent adapter initialization with timeout (`channel-registry.ts`). Adapters now start in parallel (not sequentially), each with a 90-second timeout — prevents one slow/hung adapter from blocking the entire channel init chain at startup.

## Moltbook: credential resolution rewrite

**Status:** Updated in commit `4a51169c`.

The `moltbook` CLI now supports three credential sources in priority order, with OneCLI proxy injection as the preferred method:

1. **`MOLTBOOK_API_KEY` env var** — set in host `.env` if needed (overrides).
2. **`/workspace/agent/config/moltbook_credentials.json`** — file-based fallback for local/dev setups (`MOLTBOOK_CREDS_FILE` env var to override path).
3. **OneCLI proxy injection** — when neither of the above is set, the CLI makes HTTP requests **without** an Authorization header, and the OneCLI proxy automatically injects `Authorization: Bearer <vault secret>` for requests to `www.moltbook.com*`. No local credential needed.

**SKILL.md change:** Documented the three-tier resolution order; the Moltbook API Key vault secret must exist in OneCLI with host pattern `www.moltbook.com*` and injection config `Authorization: Bearer {value}`.

**moltbook script change:** if neither env var nor file is present, `API_KEY` stays empty and curl calls omit the Authorization header, letting the proxy inject it.

## Wiki skill: new container skill

**Status:** New skill, not copied from upstream's `skill/wiki` branch — built locally.

Persistent markdown knowledge-base maintenance tools: source ingestion, entity/concept linking, search, query answering.

**Structure:**
- `/workspace/agent/sources/` — raw materials (read-only)
- `/workspace/agent/wiki/index.md` — catalog of all pages
- `/workspace/agent/wiki/log.md` — append-only timeline of operations
- `/workspace/agent/wiki/summaries/` — one page per source
- `/workspace/agent/wiki/entities/` and `concepts/` — linked reference pages
- `/workspace/agent/wiki/syntheses/` — cross-source summaries

No AI summarization in the skill itself; the agent reads sources and writes structured pages. The skill provides navigation and bookkeeping only. **Note:** upstream now also has a `skill/wiki` branch — worth diffing against on a fresh migration to see if it's worth adopting instead of the local version.

## AGENTS.md: new root-level developer guide

**Status:** Added in commit `da98e4c4`.

New file at repo root, developer quick-reference covering architecture, build/test commands, Node-host/Bun-container gotchas, container build cache notes, supply chain policy, channel/provider branch model, entity model.

**Prompt-injection safety section** (lines 137–185): documents attack patterns (instruction injection, authority spoofing, identity replacement, roleplay framing, urgency framing, hidden instructions, credential exfiltration, SSRF, confused deputy, persistent poisoning, scheduled task hijacking, subagent manipulation) and response protocol (stop, report, ask for guidance).

## Misc scripts

**`scripts/archive-conversations.ts`** (new, 401 lines): Daily transcript archiver. Reads `messages_in` + `messages_out` from every session DB for an agent group, merges them chronologically, writes plain-text markdown transcripts to `groups/<folder>/conversations/<YYYY-MM-DD>-raw.md`. Replaces the Claude provider's built-in transcript archiving (which OpenCode doesn't provide). Supports date filtering in PT timezone, backfill, dry-run modes.

**`scheduled-task-updates.js`** (new, 108 lines): One-off script to update three scheduled tasks (Clawstr 5am, MoltBook 5:30am, Sunday briefing) with new prompts. Adds Signal destination callbacks to Clawstr/MoltBook so they DM Scott a summary after posting. Rewrites briefing prompt (removes social-media section, adds metals/crypto/weather/FB tracking). One-time script — not part of the reusable install, don't port unless replaying the same task edits.

**`scripts/backup.sh`** (modified): Expanded from store-only backup to multi-tier: operational tier backs up NanoClaw (`store/`, `groups/`, `data/`) + channel state (`signal-cli/`, `whitenoise-cli/`) with 14-day rotation; records tier mirrors personal files (`Documents/`, `jorgenclaw.ai/`, etc.) additively (no `--delete`, never pruned). Skips logs on operational tier.

**`.claude/skills/claw/scripts/claw`** (modified, Python): Updated for NanoClaw v1→v2. Changed DB path from `store/messages.db` to `data/v2.db`. `get_groups()` now queries `agent_groups` table (v2) instead of `registered_groups` (v1). Enhanced directory resolution to walk up 5 levels from script location (handles being nested in `.claude/skills/claw/scripts/`).

## Summary table

| File | Change | Commit |
|------|--------|--------|
| `.claude/skills/x-integration/*` | Added `x_delete_tweet` with text-echo guard | a4867874 |
| `src/channels/signal.ts` | Route on `sourceUuid` for phone-privacy contacts | e54cab8f |
| `src/channels/channel-registry.ts` | Concurrent adapter init + timeout | e54cab8f |
| `container/skills/moltbook/*` | Three-tier credential resolution w/ OneCLI proxy | 4a51169c |
| `container/skills/wiki/*` | New wiki knowledge-base skill | local |
| `AGENTS.md` | New dev guide + prompt-injection safety section | da98e4c4 |
| `scripts/archive-conversations.ts` | New daily transcript archiver | 765b2464 |
| `scheduled-task-updates.js` | One-off task prompt updates (don't replay) | 765b2464 |
| `scripts/backup.sh` | Expanded to operational + records tiers | 765b2464 |
| `.claude/skills/claw/scripts/claw` | v1→v2 DB/table migration + path resolution | 765b2464 |
