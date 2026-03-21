# NanoClaw Sovereignty Setup

*The workshop-ready build of NanoClaw with all sovereignty-focused skills pre-installed.*

This branch (`sovereignty-setup`) is maintained by [Jorgenclaw](https://jorgenclaw.ai) and includes everything from the main [NanoClaw](https://github.com/qwibitai/nanoclaw) project **plus** the following skills that are pending upstream review:

---

## What's Included (Beyond Vanilla NanoClaw)

| Skill | What it does |
|-------|-------------|
| **Nostr Signing Daemon** | Your agent's private key never enters the container. Signs events via a host daemon over a Unix socket. |
| **Signal Messenger** | Full Signal channel support — send/receive messages, voice transcription, image handling. |
| **Nostr DM** | Private encrypted direct messages over Nostr (NIP-17). |
| **White Noise** | End-to-end encrypted group messaging over Nostr using MLS protocol. |
| **NWC Lightning Wallet** | Pay with Bitcoin Lightning. Per-transaction caps, daily spend limits, zap support. |
| **Proton Suite** | 36 MCP tools covering Proton Mail, Pass, Drive, Calendar, and VPN. |

**Why this branch exists:** These skills are submitted as PRs to the main NanoClaw repository. Until they're merged upstream, this branch gives you everything working together, tested in production, ready to run.

---

## Quick Start

### Prerequisites
- Docker + Docker Compose
- A Proton account (free tier works for most things)
- A Signal account (for the Signal channel)
- A Nostr keypair (for Nostr signing, DMs, White Noise, zapping)

### Setup

```bash
# 1. Clone this branch
git clone -b sovereignty-setup https://github.com/jorgenclaw/nanoclaw.git
cd nanoclaw

# 2. Copy the example environment file
cp .env.example .env

# 3. Fill in your credentials (see .env.example for guidance)
nano .env

# 4. Start it up
docker compose up -d
```

### Key configuration (.env)

```env
# Your AI provider
ANTHROPIC_API_KEY=sk-ant-...

# Proton credentials (for Mail, Pass, Drive, Calendar, VPN)
PROTON_EMAIL=you@proton.me
PROTON_PASSWORD=your_password
PROTON_PASS_KEY_PROVIDER=fs

# Signal phone number
SIGNAL_PHONE_NUMBER=+1234567890

# Nostr (key stays on host, never in container)
# See the Nostr Signing Daemon setup guide below
```

---

## Nostr Key Security

The most important setup step if you're using Nostr features:

**Your private key (nsec) must never enter the container.**

This branch includes the nostr-signer daemon. Your nsec lives in host kernel memory. The agent container connects via Unix socket — it gets signing capability, never the key.

Setup:
```bash
# Install the signing daemon on the host (not in Docker)
cd tools/nostr-signer
npm install

# Start it with your nsec (reads it once, keeps it in memory)
node index.js --nsec nsec1...

# The daemon writes a socket at /run/nostr-signer/signer.sock
# Mount that into your container via docker-compose.yml (already configured)
```

To revoke your agent's signing ability: `kill` the daemon process. Your key is safe — it was never on disk.

Full guide: [key-safety-report.md](key-safety-report.md) and [Sovereignty by Design](https://github.com/jorgenclaw/sovereignty-by-design/blob/main/key-safety-report.md)

---

## What You're Building

When this is running, you have:

- A personal AI agent that **you** host
- Communications over Signal (encrypted) and Nostr (sovereign)
- A Lightning wallet you control, with spending limits you set
- Encrypted file storage and calendar via Proton
- A Nostr identity with a key that never touches the AI process

This is the "Sovereignty by Design" stack. You own the infrastructure.

---

## Relationship to Upstream

This branch tracks `qwibitai/nanoclaw` main and adds the pending PRs:

- [#1056](https://github.com/qwibitai/nanoclaw/pull/1056) — Nostr Signing Daemon
- [#1057](https://github.com/qwibitai/nanoclaw/pull/1057) — Signal Channel
- [#1058](https://github.com/qwibitai/nanoclaw/pull/1058) — Nostr DM (NIP-17)
- [#1059](https://github.com/qwibitai/nanoclaw/pull/1059) — White Noise Channel
- [#1060](https://github.com/qwibitai/nanoclaw/pull/1060) — NWC Lightning Wallet
- [#1117](https://github.com/qwibitai/nanoclaw/pull/1117) — Proton Suite (36 tools)

As PRs get merged upstream, they'll be removed from this branch. The goal is to eventually have nothing here that isn't in main.

---

## Where to Go From Here

- **Full sovereignty guide:** [jorgenclaw/sovereignty-by-design](https://github.com/jorgenclaw/sovereignty-by-design)
- **Live example:** [jorgenclaw.ai](https://jorgenclaw.ai) — this is Jorgenclaw, Scott's personal agent running this exact stack
- **Sovereign MCP tools:** [mcp.jorgenclaw.ai](https://mcp.jorgenclaw.ai) — pay-per-call Nostr tools, no account needed
- **Workshop info:** [sovereigntybydesign.com](https://sovereigntybydesign.com)

---

*Maintained by [Jorgenclaw](https://github.com/jorgenclaw) · Branch from [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) · See [Sovereignty by Design](https://github.com/jorgenclaw/sovereignty-by-design) for the full guide*
