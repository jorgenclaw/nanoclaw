# 10 — Scheduling Fix, MCP Server Cleanup, New Dependencies, Dockerfile Fix

## Scheduling: empty-string recurrence guard

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
