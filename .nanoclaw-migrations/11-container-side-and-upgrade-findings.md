# 11 — Container-Side Port + Upgrade-Time Findings (2026-07-22)

Everything in this section was discovered and resolved *during* the actual `/migrate-nanoclaw` Phase 2 apply against `upstream/main` at `641963c1`, not pre-planned in sections 01–10. The old guide's file-by-file audit (sections 01-06, written 2026-05-08) missed a nontrivial number of files and undercounted how much upstream architecture had moved. This section is the definitive record of what actually got applied and why — treat sections 04/05's file lists as historical, not authoritative.

## Missing-files sweep

A systematic `comm` diff of `container/agent-runner/src/` between SOURCE and bare upstream turned up 10 files the old guide never catalogued:

| File | Verdict | Reason |
|---|---|---|
| `auto-transcribe.ts` | Ported | Genuinely new in fork (didn't exist at BASE either). Wired into `poll-loop.ts` at both call sites (initial batch + follow-up poller), before `formatMessages*`. |
| `transcription.ts` (container-side, distinct from host-side `src/transcription.ts`) | Ported | `WHISPER_MODEL_PATH` export, matches the Dockerfile's `ENV WHISPER_MODEL_PATH=/whisper/model.bin`. |
| `mcp-tools/contacts.ts` | Ported | The actual MCP tool the agent calls to trigger `register_contact` (host handler already ported in `10`/`04`). Without this file the agent has no way to invoke that handler at all. |
| `mcp-tools/report-failure.ts` | Ported | New, no upstream equivalent. |
| `mcp-tools/transcription.ts` | Ported | New, no upstream equivalent. |
| `mcp-tools/weather.ts` | Ported | New, no upstream equivalent, no env vars (no API key — check what backend it hits before assuming it's free/keyless in production). |
| `mcp-tools/web-fetch.ts` | Ported | New. Does NOT reference `WebFetch`/`WebSearch` — a separate implementation, likely for non-Claude providers that lack native fetch/search tools. |
| `mcp-tools/web-search.ts` | Ported | Same as above. |
| `mcp-tools/x-integration.ts` | Ported | **Critical** — the actual 26-tool MCP definitions (zod schemas) the agent calls. `src/modules/x-integration/index.ts` (host-side, already ported) only handles the *delivery-action* side; without this file the agent has no tools to call at all. |
| `mcp-tools/scheduling.ts` | **Dropped** | Confirmed via `git show <BASE>:...` that this file (unlike the other 9) already existed at the fork's original base — it's the OLD scheduling-MCP-tools upstream removed in the breaking change (see `10-scheduling-and-deps.md`). Porting it would resurrect dead tool definitions for a host-side handler that no longer exists. |
| `current-batch.ts` | **Dropped** | Also existed at BASE. Bare upstream's `mcp-tools/core.ts` no longer imports it (confirmed identical `core.ts` between BASE and SOURCE — Scott never touched it, upstream just stopped needing this helper during its own refactor). |

All ported files wired into `container/agent-runner/src/mcp-tools/index.ts`'s barrel (alongside `github-write`/`lightning-pay`/`nostr-post` from section `07`).

**Host-side** also had one file the old guide missed: `src/claude-md-compose.ts` differs from upstream (170 lines upstream vs 205 in the fork) — SOURCE added `migrateGroupsToClaudeLocal()`, an idempotent one-time cleanup (removes old `.claude-global.md` symlinks, renames `CLAUDE.md`→`CLAUDE.local.md`). **Not ported** — upstream's own memory-composition system has moved on (docstring now says "optional provider-neutral standing instructions" instead of referencing `CLAUDE.local.md` directly; the real migration path is `/migrate-memory`), and this cleanup almost certainly already ran during the 2026-05-08 cutover. Low risk either way since it's idempotent, but re-adding it risked fighting the new design for no benefit.

## `active-routing.ts` — needed, `db/session-routing.ts` — dropped

Both are SOURCE-only files providing "what's the current session's default reply destination" — but for different consumers and with different fates:

- **`db/session-routing.ts`** (`getSessionRouting()`) — read the host-committed default destination from `inbound.db` for MCP tools with no explicit `to`. **Superseded** by the "explicit destinations" breaking change (`send_message`/`send_file` now require `to` unconditionally) — not ported.
- **`active-routing.ts`** (`setActiveRouting`/`getActiveRouting`) — a simple module-level cache of the CURRENT batch's `RoutingContext` (from `formatter.ts`'s `extractRouting()`, which both upstream and the fork already share). This is a different, still-valid concern: HOST-GENERATED informational messages (early-warning-before-compaction, compaction notices) need to know where to send a status ping, and that logic lives in `providers/claude.ts`, one layer away from `poll-loop.ts`'s local `routing` variable. **Ported.** Wired via `setActiveRouting(routing)` right after `extractRouting()` in `runPollLoop`.

## The `guard/` collision (affects every custom `registerDeliveryAction` call)

Upstream introduced a brand-new privileged-action authorization layer (`src/guard/`) between the fork's base and now — `registerDeliveryAction` requires a third argument (`unguarded(reason)` or a real `DeliveryGuardSpec`) that didn't exist when any of this install's custom delivery actions were written. Affected every custom action, not just Passport (see `07-passport-approval-gates.md` for the Passport-specific reasoning):

- **Passport's 3 actions** (`passport_authorize`, `lightning_pay`, `nostr_post`) — `unguarded()`, reason: already gated by the Passport signed-authorization handshake, a distinct mechanism from `guard/`'s chat-approval-card system.
- **`register_contact`** (`src/contact-registration.ts`) — `unguarded()`, reason: provisions new DB entities but isn't currently gated at all (pre-existing behavior, not a downgrade). Flagged as the strongest candidate to actually move onto a real `DeliveryGuardSpec` in a future pass — it's structurally similar to `agents.create`, which upstream's own catalog already guards.
- **All 26 x-integration actions** (`src/modules/x-integration/index.ts`) — `unguarded()`, single shared reason (batch-applied via script, not hand-written per call) — Playwright browser actions via the skill's own X session, no separate host-side gate ported.

`guard/`'s `unguarded()` escape hatch is a documented, intentional codebase idiom (`cli/delivery-action.ts` already uses it for the same "gated one layer deeper" reasoning) — this isn't a workaround, it's the correct minimal fix.

## `wakeContainer()` — reverted the fork's `Promise<void>` back to upstream's `Promise<boolean>`

The fork simplified `wakeContainer`'s return type to `Promise<void>` at some point after the original base (base and current upstream both still have `Promise<boolean>` — never changed upstream side). Reverted to upstream's version because **`router.ts`** (pristine, untouched) and **`host-sweep-grace.test.ts`** (pristine) both depend on the boolean "did it actually spawn" signal for real control flow, not just a test assertion. Upstream's implementation also added a `.catch()` that converts spawn failures into `false` instead of letting them throw ("never throws" contract) — a real improvement, not just a type signature revert.

## Container networking: adopted upstream's fix, dropped `--network host`

See the full writeup in the AskUserQuestion decision during the upgrade (recorded here for the guide's continuity): SOURCE used `--network host` on bare-metal Linux as its fix for `host.docker.internal` not resolving; upstream fixed the same problem with `--add-host=host.docker.internal:host-gateway` (standard bridge networking, Docker 20.10+, keeps normal container network isolation). **Decision: adopted upstream's fix.** Consequences:

- `container-runtime.ts`: no changes needed — upstream's `hostGatewayArgs()` already does the right thing, already wired into `container-runner.ts`.
- `CONTAINER_HOST_GATEWAY` / `PROXY_BIND_HOST` (fork-only `container-runtime.ts` exports): **not ported**. `PROXY_BIND_HOST` turned out to be dead code anyway — its only caller (`src/index.ts`'s `startCredentialProxy(...)`) hardcodes `'127.0.0.1'` directly, ignoring the exported config. `CONTAINER_HOST_GATEWAY`'s one use site (in `container-runner.ts`, building `ANTHROPIC_BASE_URL` for the native credential-proxy fallback) now just uses the literal `'host.docker.internal'`, which resolves correctly everywhere under the adopted fix.
- The `172.17.0.1` OneCLI proxy-URL rewrite hack in `container-runner.ts` (worked around `--network host` breaking `host.docker.internal` resolution for OneCLI's SDK-emitted proxy URLs) — **dropped**, no longer needed.
- `onecli-approvals.ts`'s `ONECLI_GATEWAY_URL` derivation (bundled in the same historical commit but unrelated to networking mode) — **kept**, still needed regardless of container networking mode.

## `providers/claude.ts` — three-way reconciliation

Upstream evolved this file heavily (353 base → 641 upstream lines) with its own memory-hook system (`writeMemorySessionHook`, `findTranscriptPath`, `transcriptStartMs` — part of the provider-agnostic memory architecture) and its own compaction-result bugfix (don't yield compaction as a `result` event — avoids the same "duplicate message" class of bug the agent-runner hallucination filter targets). Reconciliation:

- **Kept from SOURCE** (still applies cleanly): the SDK-bundled-binary path fix. Verified empirically — `@anthropic-ai/claude-agent-sdk-linux-x64/claude` is a real 245MB binary that `bun install` actually places at `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, independent of pnpm/global-CLI concerns. This is arguably *more* robust than upstream's own `/pnpm/claude` (which depends on pnpm's global-install bin layout) — kept as an improvement, not just a compatibility shim.
- **Kept from upstream**: `mcpAllowPattern()` + the MCP-server-aware `allowedTools` list (the fork's version was `TOOL_ALLOWLIST` alone — a regression that would have silently blocked Passport's and every other MCP-server tool from being usable under the Claude provider). The full memory-hook system. The compaction-result fix.
- **Dropped**: the fork's pre-compaction "archive transcript to `/workspace/agent/conversations/` + send a Signal warning" feature. Structurally incompatible with upstream's new memory-hook functions (diff3 tried to align two unrelated functions at the same file offset). Superseded in spirit by `scripts/archive-conversations.ts` (still ported, does daily batch archiving) but the *live, mid-session* Signal warning before compaction is gone. **Follow-up candidate** if that live warning is missed in practice.
- **Kept from SOURCE** (initially looked dropped, actually still used elsewhere in the same file): the early-warning-before-compaction feature (`getActiveRouting()`/`writeMessageOut` for a "context getting full" notice at `EARLY_WARNING_THRESHOLD`). This is a *different* code location from the dropped archive/notify block — restored the `active-routing.js`/`db/messages-out.js` imports it needs.

## `container/agent-runner/src/providers/opencode.ts` — new `registerMemorySessionHook` implementation

Upstream's `AgentProvider` interface now requires `registerMemorySessionHook(hook)` (part of the provider-agnostic memory architecture). Claude Code has a native mechanism (writes to `~/.claude/settings.json`'s `hooks.SessionStart`); OpenCode has no equivalent. This is **new integration code**, not a ported customization — implemented by:
1. Storing the hook registration on the provider instance.
2. In `query()`, detecting a brand-new session (`!self.activeSessionId` before session creation) and prepending `memoryContextForSessionStart('startup')`'s output as a leading text part on the first prompt.

This covers the 'startup' case (most important — first message of a new session). 'clear'/'compact' aren't separately observable in OpenCode's event stream in this codebase, so those cases are **not** covered — a real limitation, not an oversight, but worth flagging since **this affects Scott's actual active local-first Ollama/OpenCode groups**, not a hypothetical.

**Also found and left as a flagged gap**: `buildOpenCodeConfig()`'s `instructions` array still points at `/workspace/agent/CLAUDE.local.md` directly — the OLD memory file location, predating the provider-agnostic memory tree. Not updated in this pass (would need to trace through exactly what the new memory tree's file layout looks like for OpenCode's raw-file `instructions` pipeline, which doesn't expand `@./...` includes the way Claude Code's compose step does). **Follow-up needed**: verify OpenCode-provider groups actually pick up memory content correctly post-cutover; if not, this `instructions` array is the first place to look.

## Container config `env`/`blockedHosts` — kept in the type, not wired to DB

`ContainerConfig.env` / `ContainerConfig.blockedHosts` (and the matching `ProviderContainerContext.containerEnv`) exist in the fork's schema but checked against all 11 of Scott's actual live `groups/*/container.json` files — **none use either field**. Given the new DB-backed `container_configs` architecture (`backfillContainerConfigs()`'s `LegacyContainerJson` interface doesn't include these fields either — they'd be silently dropped on backfill if they *had* been used), wiring full DB-column + migration support for an unused feature wasn't worth the risk in this pass. Kept as optional TypeScript fields for forward compatibility; `container-runner.ts` still reads `containerConfig.env`/`.blockedHosts` if ever populated by hand. **No DB migration added** — would need one if this is ever actually used.

## Provider selection mechanism changed

Per the newer `add-opencode` skill description surfaced mid-upgrade: provider config now goes through `ncl groups config update --provider opencode` (DB-backed `container_configs.provider`), not whatever mechanism existed at the fork's base. Not deeply investigated in this pass — `resolveProviderName()` (kept from upstream in `container-runner.ts`, see above) already implements the correct precedence (`session.agent_provider → container_configs.provider → 'claude'`), so this should just work once `container_configs` rows exist (via `backfillContainerConfigs()` or `ncl groups config update`). **Verify post-cutover** that Scott's OpenCode-routed groups still resolve to `opencode` correctly.

## Dockerfile: full section-05 container customizations applied

Applied on top of upstream's now-manifest-driven CLI-tool install (`cli-tools.json` + `install-cli-tools.sh`, replacing the fork-era hardcoded `RUN pnpm install -g ...` lines):

- **`opencode-ai@1.4.17`** added as a `cli-tools.json` entry (the *correct*, idiomatic way under the new system) rather than a raw Dockerfile `RUN`.
- **whisper.cpp** — ported wholesale as a new build stage (`FROM debian:bookworm-slim AS whisper-builder`), unchanged from SOURCE's approach (builds from source, not the unrelated npm `whisper-cli` package).
- **`ffmpeg`** — added to the main stage's apt package list.
- **`ws@8.20.0`** — global npm install + `/node_modules/ws` symlink (ESM resolution workaround), unchanged from SOURCE.
- **`WHISPER_MODEL_PATH=/whisper/model.bin`** — env var, matches container-side `transcription.ts`'s read of the same var.
- **NOT ported**: the fork's `ENV PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"` pnpm-11 PATH-widening fix. Upstream's current Dockerfile takes a cleaner approach — pins pnpm to an exact version (`ARG PNPM_VERSION=10.33.0`, `corepack prepare pnpm@${PNPM_VERSION} --activate`) rather than trying to handle either binary layout. Since pnpm is pinned to 10.x (old layout, bins directly at `$PNPM_HOME`), the pnpm-11 relocation problem this fix addressed doesn't arise — porting it would just be harmless dead weight, so it was skipped rather than added redundantly.

**Validated with a real `docker build`** against the upgrade worktree. Hit a BuildKit-specific issue distinct from the documented "Container Build Cache" gotcha in this repo's `CLAUDE.md`: the local BuildKit builder was serving a stale/broken build context (`transferring context: 2B` — effectively empty) even after `docker builder prune -a -f` and `--no-cache`, causing every `COPY` step to fail with "not found" for files that genuinely exist in the build context. This reproduced identically across 3 attempts (default cache, pruned cache, `--no-cache`) with the same internal ref ID each time, pointing at broken BuildKit daemon/builder state rather than anything about this Dockerfile or the migration. **Workaround**: `DOCKER_BUILDKIT=0 docker build ...` (the legacy builder) picks up the correct 754MB context immediately and builds normally. Worth a `docker buildx prune -a` / Docker Desktop or daemon restart to fix BuildKit properly before relying on it again, but not something to chase further as part of this migration — the legacy builder is a fully valid fallback and confirms the Dockerfile itself is correct.

## Validation results (this pass)

- Host: `pnpm exec tsc --noEmit` clean, `pnpm run build` clean, `pnpm test` → **101 test files / 1199 tests, all passing**.
- Container: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` clean, `bun test` (from `container/agent-runner/`) → **153 pass, 1 skip, 1 fail**.
  - The 1 failure (`poll-loop.test.ts`: "logs and conditionally nudges a second task run in the same open query") is **confirmed pre-existing upstream flakiness**, not a regression: reproduced identically (same single failure, same test) on 100%-pristine, untouched `641963c1` `poll-loop.ts` across 3 consecutive full-suite runs. Passes cleanly in isolation (`bun test -t "logs and conditionally nudges"`); only flakes as part of the full 155-test suite, consistent with resource-contention timing sensitivity (this test area has known CI-hang history visible in upstream's own commit log — `test(runner): skip the /clear-abort test pending CI-hang investigation`, `give the /clear-abort integration test CI-realistic time budgets`). Not something to fix as part of this migration.

## 2026-07-23 live-cutover findings

Discovered during live production testing on the `main` and `lauren-moore` groups (both OpenCode/Ollama-provider), before the final code swap. Both are genuine, pre-existing gaps in the OpenCode-provider path — not caused by the 720-commit upstream delta — but only surfaced once `main`'s `container.json` got its first-ever `OPENCODE_PROVIDER`/`OPENCODE_MODEL` env block (it had never been set correctly before this migration work started).

### 1. `OPENCODE_SMALL_MODEL` gap

**Symptom:** `Error: Model not found: ollama/qwen3.6:35b-a3b-q8_0-coder` on `main`'s first real message after setting `OPENCODE_PROVIDER`/`OPENCODE_MODEL`.

**Cause:** OpenCode uses a separate, smaller/cheaper model for utility calls (conversation title generation). Without `OPENCODE_SMALL_MODEL` set, it falls back to a default model name that doesn't exist for this Ollama setup.

**Fix:** Add `OPENCODE_SMALL_MODEL` alongside `OPENCODE_PROVIDER`/`OPENCODE_MODEL` in the group's `container.json` `env` block, e.g.:
```json
"env": {
  "OPENCODE_PROVIDER": "ollama",
  "OPENCODE_MODEL": "ollama/qwen3.6:35b-a3b-q8_0-jorgenclaw",
  "OPENCODE_SMALL_MODEL": "ollama/qwen3.6:35b-a3b-q8_0-jorgenclaw"
}
```
The host-side plumbing (`src/providers/opencode.ts`) already passed this env var through if present — it just needed to actually be set per-group. Applied to `groups/main/container.json` and `groups/lauren-moore/container.json` (which had independently worked around the *second* bug below with a manual `ANTHROPIC_BASE_URL` override, but was missing this one — its `OPENCODE_SMALL_MODEL` was already correctly set from earlier work).

### 2. `ANTHROPIC_BASE_URL` leaking into every provider

**Symptom:** After fixing #1, every message still failed with `Error: Not Found` — including on a freshly-created OpenCode session (ruling out stale-continuation theories). Traced via the OpenCode server's own log file (`<session>/opencode-xdg/opencode/log/*.log`) to: `AI_APICallError`, `url: "http://127.0.0.1:3001/chat/completions"`, `providerID=ollama` — i.e. a call correctly tagged for the "ollama" provider was actually hitting a completely different port.

**Root cause:** `src/container-runner.ts`'s `buildContainerArgs()` unconditionally injects `ANTHROPIC_BASE_URL=http://<gateway>:<credential-proxy-port>` (plus `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY=placeholder`) into **every** container, regardless of provider — it's meant only for Claude-provider sessions (routing Claude Agent SDK calls through the native OAuth-aware credential proxy). OpenCode's own request layer treats `ANTHROPIC_BASE_URL`, when present in env, as a universal override for **all** provider calls — not just an Anthropic-branded provider. So every OpenCode/Ollama LLM call, for every group using that provider, got silently routed into the Claude-only proxy, which 404s on OpenCode's OpenAI-style `/chat/completions` path.

**Fix:** Scope the whole Anthropic native-proxy env block in `buildContainerArgs()` to `provider === 'claude'`:
```typescript
if (provider === 'claude') {
  const authMode = detectAuthMode();
  args.push('-e', `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`);
  args.push('-e', 'NO_PROXY=api.anthropic.com,localhost,127.0.0.1');
  args.push('-e', 'no_proxy=api.anthropic.com,localhost,127.0.0.1');
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder-oauth-token');
  }
}
```
Applied and validated directly against live production traffic (both the `main` and `lauren-moore` groups recovered immediately after this fix + a container restart), then ported into the worktree with the same fix (the `provider` parameter was already threaded through as `_provider`, unused — just needed the underscore dropped and the guard added). `lauren-moore/container.json`'s manual `ANTHROPIC_BASE_URL: http://127.0.0.1:11434/v1` workaround (predating this root-cause fix) was removed as redundant once the host-level fix landed.

**Any future non-Claude provider** (Codex, a bare-Ollama-tools provider, etc.) should be checked against this same class of bug — anything that reads ambient `ANTHROPIC_*` env vars as a fallback/override is at risk from this shared-container-env pattern.

### 3. Operational lesson: don't touch a live container's bind-mounted directories from the host

While debugging the above, `rm -rf`'ing a session's `opencode-xdg` directory on the host **while its container was still running** (mid-idle, bind-mount still held open) orphaned the mount inside the container — the directory vanished from the host's view entirely, while the container's view showed a `Links: 0` (unlinked) inode. Every subsequent request in that container failed until it was killed and a fresh one spawned (which recreates the directory cleanly via `registerProviderContainerConfig`'s `fs.mkdirSync` before the mount). Not a code bug — just a reminder that host-side cleanup of session-scoped directories must check for a live container first (`docker ps --filter name=<container>`) or kill it before touching its mounts.
