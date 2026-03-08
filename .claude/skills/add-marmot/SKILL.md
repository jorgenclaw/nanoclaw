---
name: add-marmot
description: Add White Noise / Marmot protocol as a channel. Enables decentralized, end-to-end encrypted group messaging via MLS + Nostr. Compatible with the White Noise app.
---

# Add Marmot / White Noise Channel

This skill adds Marmot protocol support to NanoClaw, enabling communication via the **White Noise** app — a decentralized, end-to-end encrypted messenger built on MLS (Messaging Layer Security) and Nostr.

## What is Marmot / White Noise?

- **White Noise** is a messaging app similar to Telegram or WhatsApp, but fully decentralized
- Messages are encrypted using **MLS** (RFC 9420) with forward secrecy and post-compromise security
- Messages are transported over **Nostr** relays — no central servers
- **Marmot** is the protocol that combines MLS + Nostr

This channel lets users message NanoClaw through White Noise just like they would through WhatsApp or Signal.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `marmot` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

AskUserQuestion: Should White Noise / Marmot run alongside WhatsApp or replace it?
- **Alongside** (recommended) - Both Marmot and WhatsApp channels active
- **Replace WhatsApp** - Marmot will be the only channel

AskUserQuestion: Do you already have a Nostr private key (nsec) for this NanoClaw instance?

If they have one, collect it now. If not, we'll generate one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-marmot
```

This deterministically:
- Adds `src/channels/marmot.ts` (MarmotChannel class implementing Channel interface)
- Adds `src/channels/marmot.test.ts` (unit tests)
- Three-way merges Marmot support into `src/index.ts` (multi-channel support)
- Three-way merges Marmot config into `src/config.ts` (MARMOT_NOSTR_PRIVATE_KEY, MARMOT_NOSTR_RELAYS, MARMOT_POLL_INTERVAL_MS)
- Installs the `marmot-ts` and `nostr-tools` npm dependencies
- Updates `.env.example` with Marmot configuration variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new marmot tests) and build must be clean before proceeding.

## Phase 3: Setup

### Generate Nostr identity (if needed)

If the user doesn't have a Nostr key pair:

```bash
node -e "
import('nostr-tools').then(n => {
  const sk = n.generateSecretKey();
  const pk = n.getPublicKey(sk);
  console.log('Private key (nsec hex):', Buffer.from(sk).toString('hex'));
  console.log('Public key (npub hex):', pk);
  console.log();
  console.log('Add to .env:');
  console.log('MARMOT_NOSTR_PRIVATE_KEY=' + Buffer.from(sk).toString('hex'));
});
"
```

> **IMPORTANT**: Save this private key securely. It is the identity for your NanoClaw instance on the Marmot network. If lost, you'll need to re-join all groups.

### Choose Nostr relays

Recommended relays for Marmot / White Noise:

```
wss://relay.damus.io
wss://nos.lol
wss://relay.snort.social
wss://relay.nostr.band
```

Pick 2-4 relays for redundancy.

### Configure .env

Add to your `.env` file:

```bash
# Marmot / White Noise Channel
MARMOT_NOSTR_PRIVATE_KEY=<your-nsec-hex-from-above>
MARMOT_NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social
MARMOT_POLL_INTERVAL_MS=5000
```

### Test connection

```bash
npm run dev
```

You should see:
```
  Marmot channel: npub a1b2c3d4...
  Relays: wss://relay.damus.io, wss://nos.lol, wss://relay.snort.social
  Send a White Noise invite to this npub to start messaging
```

### Register a White Noise group

1. Open the **White Noise** app on your phone
2. Create a new group or use an existing one
3. Invite NanoClaw's npub (public key shown on startup)
4. NanoClaw will automatically detect and join the group
5. Register the group in NanoClaw:

```json
{
  "marmot:abc123def456...": {
    "name": "White Noise Group",
    "folder": "whitenoise-group",
    "trigger": "@NanoClaw",
    "added_at": "2026-03-08T00:00:00Z"
  }
}
```

The JID format for Marmot groups is `marmot:<group_id_hex>`.

## Architecture

### How it works

```
White Noise App ←→ Nostr Relays ←→ MarmotChannel ←→ NanoClaw Core
                     (MLS E2EE)
```

1. User sends message in White Noise app
2. Message is encrypted with MLS and published to Nostr relays
3. MarmotChannel subscribes to relay events, decrypts messages
4. Messages are delivered to NanoClaw via the standard `onMessage` callback
5. NanoClaw processes and responds through the same path in reverse

### JID format

- Groups: `marmot:<group_id_hex>`
- Example: `marmot:a1b2c3d4e5f67890abcdef1234567890`

### Security model

- **End-to-end encryption**: All messages encrypted with MLS (RFC 9420)
- **Forward secrecy**: Past messages stay secret even if current keys are compromised
- **Post-compromise security**: Key rotation recovers from compromise
- **No central servers**: Messages relay through Nostr (decentralized)
- **Identity separation**: Marmot nsec is separate from any Clawstr/Nostr social identity

### Dependencies

| Package | Purpose |
|---------|---------|
| `marmot-ts` | TypeScript Marmot protocol implementation |
| `nostr-tools` | Nostr relay connections and event handling |

### Configuration reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MARMOT_NOSTR_PRIVATE_KEY` | Yes | — | Nostr secret key in hex format |
| `MARMOT_NOSTR_RELAYS` | Yes | — | Comma-separated relay URLs |
| `MARMOT_POLL_INTERVAL_MS` | No | 5000 | Welcome message poll interval (ms) |

## Troubleshooting

### Channel not starting
- Verify `MARMOT_NOSTR_PRIVATE_KEY` is set and is valid hex (64 chars)
- Verify `MARMOT_NOSTR_RELAYS` contains valid `wss://` URLs
- Check logs for connection errors to relays

### Not receiving messages
- Verify the group is registered in `registered_groups.json` with a `marmot:` JID
- Check that the White Noise app and NanoClaw are using overlapping relays
- Verify key packages are published (check logs for "key package published")

### Message decryption failures
- MLS requires all group members to have current key packages
- Try rotating key packages: restart NanoClaw to trigger fresh key package generation
- Check if the group epoch is out of sync (may need to re-join)

## Contributing

This skill was created by **Jorgenclaw** as part of the NanoClaw Sovereignty Suite.

- Repository: https://github.com/jorgenclaw/nanoclaw-sovereignty-setup
- Protocol: https://github.com/marmot-protocol
- White Noise: https://github.com/marmot-protocol/whitenoise
