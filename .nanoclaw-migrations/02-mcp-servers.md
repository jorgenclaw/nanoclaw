# MCP Servers — wholesale port

Three custom MCP servers in `tools/` that Scott has built for NanoClaw v2. None exist in upstream. All copied wholesale into the worktree.

## tools/proton-mcp/

**Purpose:** MCP server for Proton suite — Mail (via Bridge IMAP/SMTP), Pass (via CLI), Drive, VPN, Calendar.

**Files (excluding node_modules):** `index.js` + 5 module subdirectories.

```
tools/proton-mcp/
├── index.js              # MCP server entry point
├── package.json          # Dependencies: imap, mailparser, nodemailer, @modelcontextprotocol/sdk
├── package-lock.json
├── mail/
│   ├── imap-client.js    # IMAP message read
│   └── smtp-client.js    # SMTP send (used for the main-rig setup emails this session)
├── pass/
│   └── pass-client.js    # Proton Pass CLI wrapper
├── drive/                # Drive client
├── vpn/                  # VPN status/control
├── calendar/             # Calendar integration
└── send-mainrig-email.mjs + send-mainrig-email-followup.mjs   # session-specific helpers
```

**Dependencies (from package.json):**
- `imap@^0.8.19`
- `mailparser@^3.6.0`
- `nodemailer@^6.9.0`
- `@modelcontextprotocol/sdk@latest`

**Wired into the agent how:** Per-group `container.json` `mcpServers` block (see e.g. `groups/main/container.json`):
```json
"proton": {
  "command": "node",
  "args": ["/workspace/extra/proton-mcp/index.js"],
  "env": {
    "PROTON_BRIDGE_IMAP_HOST": "127.0.0.1",
    "PROTON_BRIDGE_IMAP_PORT": "1143",
    "PROTON_BRIDGE_SMTP_HOST": "127.0.0.1",
    "PROTON_BRIDGE_SMTP_PORT": "1025",
    "PROTON_BRIDGE_USERNAME": "${PROTON_BRIDGE_USERNAME}",
    "PROTON_BRIDGE_PASSWORD": "${PROTON_BRIDGE_PASSWORD}"
  }
}
```

The `${VAR}` placeholders are interpolated at container spawn from process.env (see `container/agent-runner/src/index.ts` MCP placeholder handling — covered in `05-container-customizations.md`).

## tools/nostr-signer/

**Purpose:** Lightweight Nostr signing daemon. Reads nsec from the Linux kernel keyring at startup, signs events via a Unix socket, integrates with Blossom uploads and ClawStr posting.

**Files:**
```
tools/nostr-signer/
├── index.js              # Daemon entry point (binds Unix socket at $XDG_RUNTIME_DIR/nostr-signer.sock)
├── package.json          # Deps: nostr-tools, ws (WebSocket)
├── package-lock.json
├── sessions.js           # Session bookkeeping
├── rate-limiter.js       # Per-pubkey rate limiting
├── blossom-upload.js     # Blossom server upload client
└── clawstr-post.js       # ClawStr posting wrapper
```

**Service:** `nostr-signer.service` (user systemd) at `~/.config/systemd/user/nostr-signer.service`. Auto-starts on user login. Container access via mount of the socket: `/run/user/1000/nostr-signer.sock` → `/run/nostr/signer.sock`.

**clawstr-post binary:** `tools/nostr-signer/clawstr-post.js` is mounted into agent containers at `/usr/local/bin/clawstr-post` so the agent can run `clawstr-post post <subclaw> "<text>"` directly.

## tools/nwc-wallet/

**Purpose:** Lightning wallet via Nostr Wallet Connect (NWC). Used by:
- The agent (via `node /workspace/extra/nwc-wallet/index.js {balance,invoice,pay,zap,spend-status}` calls)
- The paid Nostr MCP server (`src/mcp-server.ts`) for invoice generation

**Files:**
```
tools/nwc-wallet/
├── index.js              # CLI entry point
├── package.json          # Deps: ws, nostr-tools
└── package-lock.json
```

**Connection:** `NWC_CONNECTION_STRING` env var (currently points at Rizful relay). Custodial wallet — Scott tops up.

## Application steps in worktree

```bash
WORKTREE=/home/jorgenclaw/NanoClaw/.upgrade-worktree
SOURCE=/home/jorgenclaw/NanoClaw

mkdir -p "$WORKTREE/tools/"

# Wholesale copy — these dirs don't exist in upstream
cp -r "$SOURCE/tools/proton-mcp" "$WORKTREE/tools/"
cp -r "$SOURCE/tools/nostr-signer" "$WORKTREE/tools/"
cp -r "$SOURCE/tools/nwc-wallet" "$WORKTREE/tools/"

# DO copy package-lock.json files (these are part of each tool's deps tree)
# DO NOT copy node_modules — let `npm install` regenerate

for tool in proton-mcp nostr-signer nwc-wallet; do
  cd "$WORKTREE/tools/$tool" && npm install
done
```

## Container mounts that reference these tools

The mounts are declared in each agent group's `container.json` (preserved by the data-dir rule — `groups/` is untouched). Reference for sanity:

```json
"additionalMounts": [
  { "hostPath": "~/NanoClaw/tools/proton-mcp", "containerPath": "proton-mcp", "readonly": true },
  { "hostPath": "~/NanoClaw/tools/nostr-signer", "containerPath": "nostr-tools", "readonly": true },
  { "hostPath": "~/NanoClaw/tools/nwc-wallet", "containerPath": "nwc-wallet", "readonly": true },
  { "hostPath": "~/.proton-mcp", "containerPath": "proton-bridge-config", "readonly": true },
  { "hostPath": "~/.local/share/proton-pass-cli", "containerPath": "proton-pass-cli", "readonly": false },
  { "hostPath": "~/.local/bin/pass-cli", "containerPath": "pass-cli-bin/pass-cli", "readonly": true }
]
```

These all point at the host paths in `~/NanoClaw/tools/` which become `~/NanoClaw/` after cutover (same path) — no edits needed.

## External dependencies (host-level, not in NanoClaw repo)

These run on the host outside the container. They're not affected by migration but worth knowing:
- **Proton Bridge** (Mac app or Linux daemon) — exposes IMAP at 1143 / SMTP at 1025
- **Proton Pass CLI** at `~/.local/bin/pass-cli`
- **signal-cli** at `/usr/local/bin/signal-cli`, daemon on tcp 7583
- **nostr-signer daemon** systemd user unit (auto-starts)
- **Ollama** at 127.0.0.1:11434 with gemma4:26b-jorgenclaw, gemma4:31b-coder, llama4:scout
- **whisper-cli** at `~/.local/bin/whisper-cli` for host-side transcription fallback
- **OneCLI gateway** for credential injection (when in use)
- **cloudflared** for jorgenclaw-mcp Tunnel (proton, mcp, nostr, blossom, hs subdomains)
- **Headscale** at 127.0.0.1:8080 (dormant)
