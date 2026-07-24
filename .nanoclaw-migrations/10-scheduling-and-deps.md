# 10 — Scheduling Fix, MCP Server Cleanup, New Dependencies, Dockerfile Fix

## ⚠️ Scheduling architecture superseded upstream (decided 2026-07-22, during upgrade)

Upstream's `641963c1` removed the scheduling MCP tools entirely and replaced the scheduling module with a CLI-based `ncl tasks` model (`src/cli/resources/tasks.ts`; `src/modules/scheduling/` reshaped to `create.ts`/`db.ts`/`recurrence.ts`/`run-log.ts`, dropping `actions.ts`/`central-db.ts`/`central-recurrence.ts`/`index.ts` entirely). This is upstream `CHANGELOG.md`'s "**Scheduled tasks moved from MCP tools to `ncl tasks`**" breaking change.

**Decision:** adopt upstream's new architecture as-is rather than porting the old MCP-tool-based scheduling customizations onto it. **Do not port** the empty-string-recurrence guard's SQL/validation changes to `actions.ts`/`central-db.ts`/`central-recurrence.ts` below as originally written — those files don't exist upstream anymore. **Follow-up needed post-cutover:** recreate the custom scheduled tasks (Clawstr 5am post, MoltBook 5:30am post, Sunday morning briefing — see `09-misc-customizations-jul2026.md`'s note on `scheduled-task-updates.js`, and the Modelfile-tuned prompts) using `ncl tasks create` against the new architecture. Not done as part of this migration — tracked as a manual step.

**Exception — the empty-string bug itself was reapplied** (2026-07-22, during upgrade): confirmed upstream's new `db.ts`/`recurrence.ts` still has the identical bug (`getCompletedRecurring` only checks `recurrence IS NOT NULL`, `CronExpressionParser.parse()` called with no format validation). Since this is a small, isolated correctness fix independent of the deferred architecture rework, it was reapplied directly to the new files in the upgrade worktree:
- `src/modules/scheduling/db.ts`, `getCompletedRecurring()`: query changed to `WHERE status IN ('completed', 'failed') AND recurrence IS NOT NULL AND recurrence != ''`.
- `src/modules/scheduling/recurrence.ts`, `handleRecurrence()`: added the same format guard before `CronExpressionParser.parse(msg.recurrence, ...)`:
  ```ts
  if (typeof msg.recurrence !== 'string' || msg.recurrence.split(' ').length < 5) {
    log.warn('Skipping recurrence with malformed cron expression', { messageId: msg.id, recurrence: msg.recurrence });
    continue;
  }
  ```
- A regression test was added to `src/modules/scheduling/recurrence.test.ts` (new upstream shape) mirroring the original test's intent.

The rest of this section (below) describes the **original** fix as applied to the **old** file structure — kept for historical record only, since section `01`-`06` describe the fork state those files existed in. Do not reapply verbatim to a checkout at `641963c1` or later.

## Scheduling: empty-string recurrence guard (historical — see superseded note above)

**Status:** Fixed in commit `aa9d8167`.

**Problem**: an UPDATE that set `recurrence = ''` (empty string instead of NULL) caused a runaway loop of cloned tasks:
- The SQL condition `IS NOT NULL` treats empty strings as truthy.
- `cron-parser`'s `CronExpressionParser.parse('')` doesn't throw on empty input — it returns a parser that yields a "next run" a couple of minutes in the future.
- The recurrence handler cloned the same task repeatedly every 60s sweep.

**Fixes applied (defense in depth, all four layers):**

1. **SQL guards** (`src/modules/scheduling/db.ts`, `src/modules/scheduling/central-db.ts`):
   ```sql
   WHERE status = 'completed' AND recurrence IS NOT NULL AND recurrence != ''
   ```

2. **Input normalization** (`src/modules/scheduling/actions.ts`):
   ```typescript
   const r = content.recurrence as string | null;
   update.recurrence = r === '' ? null : r;
   ```

3. **Validation at consume time** (`src/modules/scheduling/recurrence.ts`, `src/modules/scheduling/central-recurrence.ts`):
   ```typescript
   if (typeof msg.recurrence !== 'string' || msg.recurrence.split(' ').length < 5) {
     log.warn('Skipping recurrence with malformed cron expression', {
       messageId: msg.id,
       recurrence: msg.recurrence,
     });
     continue;
   }
   ```
   A valid 5-field cron expression needs at least four spaces — catches whitespace-only/truncated values that slip past the other two layers.

4. **Regression test** (`src/modules/scheduling/recurrence.test.ts`): inserts an empty-string recurrence directly and confirms the handler doesn't clone rows.

`src/modules/scheduling/actions.ts`, `central-db.ts`, and `central-recurrence.ts` have no other substantive changes in this range beyond the guard above.

## MCP server: TypeScript annotation cleanup

`src/mcp-server.ts` — all nine async MCP tool handlers changed from implicitly-typed `async (args) => {...}` to explicit `async (args: any) => {...}`. Pure type-annotation fix for stricter TypeScript checking (the MCP SDK's tool-handler signature got stricter, and since `inputSchema` is raw JSON Schema rather than a Zod object, the SDK can't infer arg types). No functional change.

## New dependencies

| Dependency | Version | Subsystem | Purpose |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.29.0` | `src/mcp-server.ts` | Paid Nostr MCP gateway (sign/publish events, notes, zaps, invoices, receipts) |
| `@noble/curves` | `^2.2.0` | `src/modules/approvals/passport/signer.ts`, `verify.ts` | secp256k1 for Passport signing gates |
| `nostr-tools` | `^2.23.3` | `src/channels/nostr-dm.ts` | Nostr relay pool management for NIP-17 private DMs |
| `openai` | `^6.34.0` | `src/transcription.ts` | Voice-note transcription fallback (local whisper-cli unavailable) |
| `ws` | `^8.20.0` | `src/mcp-server.ts` | WebSocket client for MCP server Nostr relay connections |
| `zod` | `^4.3.6` | `src/mcp-server.ts` | Schema validation for MCP tool input |
| `playwright-core` | `1.59.1` | (no direct `src/` imports yet) | Browser automation capability, likely for a future container skill |
| `@types/ws` (dev) | `^8.18.1` | type defs | TypeScript types for `ws` |

## Dockerfile: pnpm 11 PATH fix

**Status:** Fixed in commit `4a51169c`.

```dockerfile
# Before:
ENV PATH="$PNPM_HOME:$PATH"

# After:
ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
```

pnpm 10 and earlier place global binaries directly at `$PNPM_HOME`; pnpm 11 (released May 2026) moved them to `$PNPM_HOME/bin`. When `corepack enable` resolves to pnpm 11 on a fresh build, native-binary tools spawned by the agent (e.g. `claude-code`, `vercel`) fail with "binary not found" unless both paths are present. Listing both keeps the build working across corepack-resolved versions.

**Related, see `08-agent-runner-reliability.md` §3**: this same PATH change is what moved Claude Code's binary and required the `pathToClaudeCodeExecutable` fix in `claude.ts`.
