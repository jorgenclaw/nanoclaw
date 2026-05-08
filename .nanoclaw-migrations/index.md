# NanoClaw Migration Guide — Scott's sovereign-first install

**Generated:** 2026-05-08
**Base (merge-base with upstream/main):** `cf2b1c9755e2b547bd012aaa5cd14116e28c71c7`
**HEAD at generation:** (current state of `skill/x-integration-v2-linux` after the 2026-05-08 substantive-work commit)
**Upstream HEAD:** `ef43cbb` (`upstream/main` as of fetch on 2026-05-08)
**User commits ahead of base:** 30
**Upstream commits ahead of base:** 461

## Tier classification: 3 (complex)

This is a deep fork. Customizations span 5 entirely-new channel adapters, X-integration v2 (24 tools), 3 custom MCP servers, paid Nostr MCP gateway, security policy engine, container Dockerfile additions (whisper.cpp, ffmpeg, OpenCode runtime), and ~15 non-standard subsystems totaling ~9,000 lines of customization. Standard `/update-nanoclaw` (merge-based) would produce hundreds of conflicts; intent-based migration is the right approach.

## Migration plan

Order of operations for the Upgrade phase (`.upgrade-worktree/`):

1. **Worktree at clean upstream/main** (`git worktree add .upgrade-worktree upstream/main --detach`)
2. **`pnpm install`** in the worktree to baseline dependencies
3. **Apply custom skills** wholesale from the old install (see `01-skills.md`)
4. **Apply custom MCP servers** wholesale from the old install (see `02-mcp-servers.md`)
5. **Apply custom scripts** wholesale (see `03-scripts.md`)
6. **Apply config.ts + .env additions** (see `06-config-and-env.md`) — these are the env-var registry that everything else depends on
7. **Apply source customizations** in dependency order (see `04-source-customizations.md`):
   - First: shared infrastructure (security-policy.ts, transcription.ts, health.ts, contact-registration.ts)
   - Then: container infrastructure (container-config.ts schema, container-runtime.ts detection, container-runner.ts wiring)
   - Then: providers (opencode.ts) and credential proxy
   - Then: channel adapters (signal.ts, watch.ts, whitenoise.ts, nostr-dm.ts) — register via index.ts barrel
   - Then: modules/x-integration/index.ts and host-sweep.ts (depend on channels for delivery)
   - Last: src/mcp-server.ts (paid Nostr gateway — independent runtime, low risk)
8. **Apply container customizations** in order (see `05-container-customizations.md`):
   - Dockerfile (multistage whisper.cpp + version-pinned ws/opencode/bun)
   - container/agent-runner/package.json + bun.lock dependencies
   - container/agent-runner/src/providers/opencode.ts + mcp-to-opencode.ts
   - container/agent-runner/src/poll-loop.ts (auto-transcribe wiring + canonical session_routing)
   - container/agent-runner/src/mcp-tools/* (X-integration, report-failure, MoltBook, etc.)
9. **Run `./container/build.sh`** to rebuild the agent image with all customizations
10. **Run `pnpm run build && pnpm test`** to verify host
11. **Validate** the new install runs cleanly against existing `groups/`, `data/`, `store/`, `.env`

## Sections

| File | Contents |
|---|---|
| `01-skills.md` | Custom skills wholesale port + deprecation decisions |
| `02-mcp-servers.md` | tools/proton-mcp, nostr-signer, nwc-wallet — wholesale port |
| `03-scripts.md` | Custom scripts to copy + scripts to drop |
| `04-source-customizations.md` | Host-side `src/` customizations file by file |
| `05-container-customizations.md` | `container/` customizations file by file |
| `06-config-and-env.md` | New config.ts exports + required .env vars |

## Critical risks for the Upgrade phase

| Risk | Mitigation |
|---|---|
| **461 upstream commits behind** — some upstream changes may have rewritten files Scott has heavily customized (e.g. `src/container-runner.ts`, `src/host-sweep.ts`). Could cause "the function I'm patching has been removed" situations. | Each source customization in `04-source-customizations.md` includes the EXPECTED current-upstream state. If the worktree shows different state, flag and ask Scott. Don't blindly apply. |
| **5 entirely-new channel adapters** with no upstream equivalents | All four files (`signal.ts`, `watch.ts`, `whitenoise.ts`, `nostr-dm.ts`) are net-new — copy wholesale into worktree. No conflict possible. |
| **paid Nostr MCP gateway (977 lines)** depends on Lightning + Cloudflare KV + NWC | Verify external dependencies (NWC config, Cloudflare credentials in env) survive cutover. The code is self-contained — port wholesale. |
| **Container image rebuild** required — large multistage Dockerfile change | `./container/build.sh` is well-tested. Verify whisper.cpp v1.8.3 still builds against current Debian bookworm. Pin all versions exactly (see `05-container-customizations.md`). |
| **Cherry-pick manifest preserved** | `.cherry-pick-manifest.txt` is currently stashed for safekeeping. Post-migration, archive it under `groups/main/archive/migration-history/` then delete from worktree. |

## Post-cutover cleanup (Phase D.4)

- Archive `groups/main/docs/reference/setup/MIGRATION_HANDBOOK.md` and `bitwarden-migration-complete.md` and `report-moltbook-v2-migration.md` to `groups/main/archive/migration-history/`
- Keep `groups/main/docs/evo-x2-migration.md` as durable reference
- Delete `.cherry-pick-manifest.txt` (was stashed before migration; restore from stash if Scott wants final preservation, then delete)

## Validation checklist (Phase D verification)

After cutover, verify:
1. `systemctl --user is-active nanoclaw` → `active`
2. All 5 conversational groups respond on local Gemma (main, lise, lauren-moore, ellen-moore, lauren-scott)
3. Scheduled tasks fire correctly (next morning briefing + scheduled archaeology fires into archaeology group)
4. OpenCode dev tool still works: `cd ~/NanoClaw && opencode` launches on `gemma4:31b-coder`
5. Memory preserved: `wc -c groups/main/memory/self.md` returns ≥145000 bytes; `groups/main/memory/soul.md` exists at all 5 groups
6. MCP servers: tools/{proton-mcp,nostr-signer,nwc-wallet} intact and functional
7. Custom Modelfiles still loaded: `ollama list` shows `gemma4:26b-jorgenclaw`, `gemma4:31b-coder`, `llama4:scout`
8. Security section + Images section present in all 5 groups' CLAUDE.local.md
9. Migration cruft gone: `migrate-v2.sh`, `migrate-v2-reset.sh`, the v1→v2 banner — none should be present in the new install root
