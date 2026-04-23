# NanoClaw v2 Rebase Playbook

Step-by-step plan for bringing this fork up to `qwibitai/nanoclaw` main (v2.0.7+).

Written 2026-04-23 after a deep divergence audit. Intended to be consulted during a live `/update-nanoclaw` session, not followed blindly.

## State at time of writing

- Our branch: `feat/quad-inbox-deferred` (+ `main`)
- Last commit on `main`: our local `3c60b76` (2026-04-23)
- Upstream tip: `cf2b1c9` (`qwibitai/nanoclaw` main)
- Our version: 1.2.52 — Upstream version: 2.0.7
- Commits ahead: 28 — Commits behind: 845
- Merge base: `8f91d3b`
- Files changed on both sides: 45
- Backup tag: `backup/pre-phase1-credentials-20260423-123443`

## Order of operations

### 0. Pre-flight

```bash
git status --porcelain   # must be clean
git fetch upstream
git tag "backup/pre-rebase-$(date +%Y%m%d-%H%M%S)"
git branch "backup/main-pre-rebase-$(date +%Y%m%d-%H%M%S)"
```

Run the existing test suite and capture the baseline:

```bash
pnpm test 2>&1 | tee /tmp/baseline-test.log
npm run build 2>&1 | tee /tmp/baseline-build.log
```

### 1. Run `/update-nanoclaw` with `merge` path

Skill lives at `.claude/skills/update-nanoclaw/SKILL.md`. It will:
1. Create its own backup branch + tag
2. Preview the 845-commit changelog grouped by category
3. Run dry-run conflict detection
4. Guide you through resolution
5. Run `pnpm run build` + `pnpm test`
6. Walk through CHANGELOG breaking changes

Expected conflict categories (from audit):

| Category | Files | Risk | Notes |
|---|---|---|---|
| Skills docs | `.claude/skills/setup/`, `.claude/skills/update-nanoclaw/` | Low | Take upstream |
| Source (channels) | `src/channels/*.ts` (whatsapp, signal, etc.) | Medium | See §2 below |
| Source (DB) | `src/db/migrations/010*.ts`, `011*.ts` | **High** | See §3 below |
| Source (core) | `src/router.ts`, `src/index.ts`, `src/container-runner.ts`, `src/contact-registration.ts`, `src/db/messaging-groups.ts` | **High** | See §4 below |
| Build/config | `package.json`, `package-lock.json`, `container/Dockerfile`, `container/agent-runner/package.json` | Medium | Merge deps, re-lockfile |
| Tests | `src/*.test.ts` under `channels/`, `db/`, `host-core`, `router`, `delivery` | Medium | Update assertions for new schema (§3) |

### 2. Files upstream deleted that we kept — safe to take upstream's deletion

Our 21 "kept" files are mostly V1 remnants that our V2 merge didn't clean up:

- `src/channels/whatsapp.ts`, `whatsapp.test.ts`, `whatsapp-auth.ts` — upstream moved to `channels` branch. Take deletion. WhatsApp wasn't in use.
- `src/ipc.ts`, `ipc-auth.test.ts` — old IPC layer. Take deletion.
- `src/task-scheduler.ts`, `task-scheduler.test.ts` — old scheduler. Take deletion. Our `src/modules/scheduling/` replaces it.
- `src/db.ts`, `db.test.ts` — upstream moved to `src/db/*.ts` (directory). We already have the directory. Take deletion of the file.
- `src/router.ts`, `src/routing.test.ts`, `src/group-queue*`, `src/logger.ts`, `src/group-folder.ts` — see §4
- `src/formatting.test.ts` — check if replaced by another test file upstream
- `skills-engine/apply.ts`, `skills-engine/structured.ts`, `.github/workflows/skill-drift.yml`, `package-lock.json`, `container/agent-runner/package-lock.json` — take deletions (upstream moved away from npm to pnpm/bun)

### 3. Migration collision — the ONLY hard conflict

| Version | Ours | Upstream | Resolution |
|---|---|---|---|
| 010 | `token-usage` (token cost table) | `engage-modes` (schema rewrite) | **Keep both.** Migration framework keys on `name` not `version`, so both apply. Rename our file to `013-token-usage.ts` for clarity. |
| 011 | `scheduled-tasks` (our central task storage) | `pending-sender-approvals` (new table) | **Keep both.** Rename ours to `014-scheduled-tasks.ts`. |
| 012 | (none) | `channel-registration` | Take upstream. |

Renames needed:

```bash
git mv src/db/migrations/010-token-usage.ts src/db/migrations/013-token-usage.ts
git mv src/db/migrations/011-scheduled-tasks.ts src/db/migrations/014-scheduled-tasks.ts
# Edit src/db/migrations/index.ts: rename imports to migration013, migration014,
# bump the `version` field inside each migration file from 10→13, 11→14
# (cosmetic — framework auto-assigns applied version).
```

The two `011-*.ts` files can't both have filename `011-*.ts` post-merge. Ours must be renamed.

### 4. Engage-modes schema rewrite — the BIGGEST post-merge work

Upstream's `010-engage-modes` migration:
- ADDS columns: `engage_mode` / `engage_pattern` / `sender_scope` / `ignored_message_policy`
- BACKFILLS from `trigger_rules` + `response_scope`
- DROPS `trigger_rules` and `response_scope`

Our code currently reads/writes those dropped columns in **8 files**. Each will need updating after the merge:

| File | Line | What to change |
|---|---|---|
| `src/db/schema.ts` | 38–39 | Replace `trigger_rules`, `response_scope` fields with the 4 new columns |
| `src/db/messaging-groups.ts` | 90–91, 163 | Rewrite INSERT and UPDATE to use new column set |
| `src/router.ts` | 242–259 | Replace trigger_rules JSON parsing with `engage_mode`/`engage_pattern` checks |
| `src/index.ts` | 139, 198–203 | Replace `requiresTrigger` computation with `engage_mode` check |
| `src/contact-registration.ts` | 30, 102, 107–108 | Write `engage_mode='pattern'`, `engage_pattern='@Jorgenclaw'` instead of JSON trigger_rules |
| `src/channels/adapter.ts` | 13 | Replace `requiresTrigger: boolean` with `engageMode: 'pattern' \| 'mention' \| 'mention-sticky'` |
| `src/channels/channel-registry.test.ts` | 152–153 | Update test fixture |
| `src/db/db-v2.test.ts` | 181–182 | Update test fixture |
| `src/host-core.test.ts` | 203–204 | Update test fixture |

**Backfill rules** (from upstream's migration):
- `pattern` non-empty → `engage_mode='pattern'`, `engage_pattern=<pattern>`
- `requiresTrigger === false` OR `response_scope === 'all'` → `engage_mode='pattern'`, `engage_pattern='.'`
- Else → `engage_mode='mention'`, `engage_pattern=NULL`
- `response_scope === 'allowlisted'` → `sender_scope='known'`, else `'all'`

This can be done in one focused pass after the merge lands — read the engage-modes migration for the full semantics, then apply the same mapping in our code.

### 5. Our novel work that upstream will want

Consider filing upstream PRs for:

- **Central scheduled_tasks storage** (`0318b20`) — our `scheduled_tasks` central DB pattern is genuinely better than upstream's per-session storage. Novel contribution.
- **Credential env-var interpolation** (`d78e6c7`, `3c60b76`) — the `${VAR}` placeholder pattern in `NANOCLAW_MCP_SERVERS` + the skill-binary PATH auto-symlink. Small but useful.

### 6. Channel conflict resolution — medium-risk

Upstream has continued refactoring the router/channel boundary since our fork:

- Router now owns all policy; channels are transport-only
- SDK isMention signal replaces regex `hasMention`
- `accumulate` mode wired through bridge
- `replyTo` override + CLI admin-transport flows

Our custom channels (`watch`, `nostr-dm`, `whitenoise`, `signal`) sit at this boundary. Expected work:

1. Take upstream's `src/channels/channel-registry.ts`, `src/channels/chat-sdk-bridge.ts`, `src/router.ts` updates
2. Port each of our custom channels to the new interface (review each one)
3. Signal adapter's `replyTo` fix (our commit `3e69413`) may already be in upstream — check before re-applying
4. Validate: Signal round-trip test, watch upload test, Nostr DM round-trip, WhiteNoise post

### 7. CHANGELOG breaking-change walkthrough

`/update-nanoclaw` will auto-surface these. Decisions you'll face:

| Version | Breaking change | Our action |
|---|---|---|
| 2.0.0 | New entity model (users/roles/groups) | **Already on it** — our V2 merge did this. Take upstream's refinements. |
| 2.0.0 | Two-DB session split | **Already on it** — confirm our version matches upstream's. |
| 2.0.0 | `bash nanoclaw.sh` installer | Skip — we don't use the installer; have our own systemd service. |
| 2.0.0 | Channels moved to `channels` branch | We keep channels in-tree. `/update-nanoclaw` will ask if we want to install from branch — **decline**; our custom channels stay where they are. |
| 2.0.0 | Providers moved to `providers` branch | Same answer — decline. |
| 2.0.0 | Three-level channel isolation | Review `messaging_group_agents.session_mode` column — make sure ours matches. |
| 2.0.0 | Apple Container removed | N/A — we're on Docker. |
| 2.0.0 | OneCLI Agent Vault is sole credential path | **Run `/init-onecli` after the merge lands.** This is the natural moment. |

### 8. Post-merge validation

```bash
pnpm run build
pnpm test
./container/build.sh            # rebuild container image
systemctl --user restart nanoclaw

# Send a test message on each channel to confirm end-to-end:
# - Signal DM
# - Watch memo POST
# - Nostr DM
# - WhiteNoise post (if daemon running)
# - cli channel (simple echo)

# Verify scheduled tasks still present
node -e "const db = require('better-sqlite3')('data/v2.db'); console.log('pending:', db.prepare(\"SELECT COUNT(*) FROM scheduled_tasks WHERE status='pending'\").get());"

# Verify MoltBook skill works
docker exec <container> bash -c 'moltbook me' | head -3
```

### 9. Rollback if anything breaks

```bash
# Backup branch printed at start of /update-nanoclaw run — it's recoverable.
git reset --hard backup/pre-rebase-<timestamp>
# Or use the tag created in §0.
```

Local state (groups/, store/, data/) is outside git — safe across branch resets.

## Estimated session budget

- **Merge + conflict resolution**: 60–90 min
- **Engage-modes schema adaptation** (§4): 45–60 min
- **Channel adapter port** (§6): 60–120 min, depending on what's changed
- **Validation** (§8): 30–45 min
- **Total**: 3–5 hours with active review

Request Claude Ultra for this session. Have Signal open to test the round-trip.

## Don't rebase during

- Active scheduled tasks firing (midnight consolidation + morning briefing window = 5am–7am PDT)
- Any critical user-facing workflow Scott needs that day
- While Proton Bridge IMAP or signal-cli is flaky

Good windows: mid-morning PDT weekdays (after morning tasks, before email flow picks up).
