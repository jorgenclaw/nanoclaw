# Host-side `src/` customizations

This is the bulk of the migration work. ~6,500 lines of host-side customization across ~15 subsystems. Apply in dependency order (per `index.md` plan).

## Application strategy

For each file below, the migration steps:

1. Read the corresponding file in the worktree (clean upstream/main version)
2. Compare to the expected baseline (what was in upstream before Scott's changes)
3. If the worktree file matches expected baseline → apply Scott's changes from current install
4. If the worktree file differs significantly (upstream rewrote it) → flag for manual review

For files that are entirely NEW (didn't exist in upstream): just copy from current install.

## NEW FILES (copy wholesale into worktree)

These don't exist in upstream/main — copy as-is:

| File | Purpose | LOC |
|---|---|---|
| `src/channels/signal.ts` | Signal Protocol via signal-cli TCP/JSON-RPC | 646 |
| `src/channels/watch.ts` | T-Watch S3 HTTP server + audio transcription | 509 |
| `src/channels/whitenoise.ts` | WhiteNoise MLS via `wn` CLI socket | 283 |
| `src/channels/nostr-dm.ts` | Nostr NIP-17 DM via WebSocket relays | 390 |
| `src/modules/x-integration/index.ts` | X delivery action registrations + paced subprocess invocation | 434 |
| `src/providers/opencode.ts` | OpenCode container config + auto-wipe on model change | 161 |
| `src/credential-proxy.ts` | Native Anthropic auth proxy (OAuth + API key) | 89 |
| `src/security-policy.ts` | Tool whitelist, bash regex blocks, WebFetch rules, killswitch | 363 |
| `src/transcription.ts` | Local whisper-cli + OpenAI fallback | 77 |
| `src/health.ts` | Alert dedup (1-hour coalesce window) | 33 |
| `src/contact-registration.ts` | Contact approval delivery action | 151 |
| `src/mcp-server.ts` | Paid Nostr MCP gateway with Lightning + Cloudflare KV | 977 |

```bash
WORKTREE=/home/jorgenclaw/NanoClaw/.upgrade-worktree
SOURCE=/home/jorgenclaw/NanoClaw

mkdir -p "$WORKTREE/src/channels" "$WORKTREE/src/modules/x-integration" "$WORKTREE/src/providers"

for f in \
  src/channels/signal.ts \
  src/channels/watch.ts \
  src/channels/whitenoise.ts \
  src/channels/nostr-dm.ts \
  src/modules/x-integration/index.ts \
  src/providers/opencode.ts \
  src/credential-proxy.ts \
  src/security-policy.ts \
  src/transcription.ts \
  src/health.ts \
  src/contact-registration.ts \
  src/mcp-server.ts; do
  cp "$SOURCE/$f" "$WORKTREE/$f"
done
```

## MODIFIED EXISTING FILES (apply changes carefully)

These files exist in upstream and may have been rewritten in the 461 commits since base. For each: diff worktree against expected baseline first, only apply if files match.

### `src/index.ts` (+56 / -1)

**Intent:** Initialization sequence — start credential proxy, init health monitor, load security policy, eager-migrate session DBs, conditionally launch MCP server.

**Apply:** Add the new imports (channels, modules, credential-proxy, health, security-policy, mcp-server) in the appropriate sections. Add their startup function calls in the right order:
1. Database migrations
2. Channels register (self-registration via barrel imports)
3. Modules register (self-registration)
4. Security policy load
5. Health monitor init
6. Credential proxy start (if configured)
7. MCP server conditional launch (if `MCP_SERVER_ENABLED=true`)
8. Sweep + delivery loops

Reference the current file at `src/index.ts` for the exact structure.

### `src/channels/index.ts` (+4 / -0)

**Intent:** Barrel imports for self-registration of new channels.

**Apply:** Add 4 import lines (the upstream version may not have these channels):
```typescript
import './signal.js';
import './watch.js';
import './whitenoise.js';
import './nostr-dm.js';
```

### `src/modules/index.ts` (+1 / -0)

**Intent:** Register x-integration delivery actions.

**Apply:** Add `import './x-integration/index.js';` to the modules barrel.

### `src/host-sweep.ts` (+221 / -5)

**Intent:** Central scheduled-task system. Adds `sweepCentralTasks()` for recurrence handling, due-task dispatch into session inbound.db, and a precise wake timer for sub-60s scheduling precision.

**Apply:** Substantial rewrite. The current `src/host-sweep.ts` in this install is the source of truth — copy it onto the worktree's version IF the structure matches. If upstream has rewritten the sweep loop, flag for manual reconciliation.

Key insertions (from the diff):
- `let preciseTimer: ReturnType<typeof setTimeout> | null = null;` near top
- `sweepCentralTasks()` function (new) — read full implementation from current file
- Modified `sweep()` to track `earliestDue` and schedule `preciseTimer` if next task fires within `SWEEP_INTERVAL_MS`

### `src/container-runner.ts` (+129 / -2)

**Intent:** Channel container config integration; OneCLI proxy bridge rewrite (`host.docker.internal` → `172.17.0.1` on bare-metal Linux); main-group secret injection from `.env` (GH_TOKEN, AWS, NWC, Proton Bridge, MoltBook); skill binary symlink bootstrap; per-group env overrides + blocked hosts.

**Apply:** This file may have been rewritten by upstream. Carefully diff. The key feature additions:

1. **Proxy bridge rewrite** (around the OneCLI args section):
```typescript
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-e' && args[i + 1].includes('host.docker.internal')) {
    args[i + 1] = args[i + 1].replace(/host\.docker\.internal/g, '172.17.0.1');
  }
}
```

2. **Main-group secret injection** (where the spawn args are assembled):
```typescript
const mainSecrets = readEnvFile([
  'GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION', 'REMOTION_AWS_BUCKET', 'REMOTION_SERVE_URL',
  'NWC_CONNECTION_STRING',
  'PROTON_BRIDGE_USERNAME', 'PROTON_BRIDGE_PASSWORD',
  'MOLTBOOK_API_KEY',
  'UDIOAPI_PRO_KEY',
]);
if (agentGroup.folder === 'main') {
  for (const [key, value] of Object.entries(mainSecrets)) {
    if (value) args.push('-e', `${key}=${value}`);
  }
}
```

3. **Skill binary bootstrap** (the entrypoint command):
```typescript
const bootstrap = [
  'mkdir -p ~/.local/bin',
  'for f in /home/node/.claude/skills/*/*; do ' +
    '[ -x "$f" ] && [ ! -d "$f" ] && ln -sf "$f" "$HOME/.local/bin/$(basename "$f")"; ' +
    'done 2>/dev/null || true',
  'export PATH="$HOME/.local/bin:$PATH"',
  'exec bun run /app/src/index.ts',
].join('; ');
// Use as the container's bash -c command
```

4. **Per-group env overrides + blocked hosts** (new container config fields applied to docker args).

### `src/container-config.ts` (+6 / -0)

**Intent:** Schema additions to ContainerConfig.

**Apply:** Add these fields to the interface:
```typescript
env?: Record<string, string>;
blockedHosts?: string[];
```

### `src/container-runtime.ts` (+18 / -1)

**Intent:** Detect bare-metal Linux vs WSL/Docker Desktop.

**Apply:** Add this exported helper:
```typescript
function isBareMetalLinux(): boolean {
  try {
    fs.accessSync('/proc/sys/fs/binfmt_misc/WSLInterop');
    return false;
  } catch {
    return true;
  }
}
export const CONTAINER_HOST_GATEWAY = isBareMetalLinux() ? '127.0.0.1' : 'host.docker.internal';
export const PROXY_BIND_HOST = isBareMetalLinux() ? '172.17.0.1' : 'host.docker.internal';
```

### `src/config.ts` (+98 / -3)

**Intent:** Export PROJECT_ROOT, HOME_DIR (now public); add 30+ new env-var-driven config exports.

**Apply:** See `06-config-and-env.md` for the complete env-var registry.

### Database migrations

**Intent:** Several new migrations in `src/db/migrations/` for the central task system, contact registration, etc.

**Apply:** Copy any new migration files (they're sequentially numbered; check current `src/db/migrations/` listing vs upstream to identify which numbers Scott's added).

## Verification per file

After applying each, run `pnpm exec tsc --noEmit` in the worktree. Type errors indicate the apply step needs adjustment.

## High-risk files (likely upstream rewrites)

These three files are most likely to have been rewritten by upstream in 461 commits:
- `src/container-runner.ts` — core container spawn logic
- `src/host-sweep.ts` — main sweep loop
- `src/index.ts` — initialization entry point

Strategy: read the worktree (clean upstream) versions FIRST. Identify the right insertion points for Scott's customizations. If upstream has restructured significantly, present the conflict to Scott.
