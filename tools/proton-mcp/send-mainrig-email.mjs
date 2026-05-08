#!/usr/bin/env node
// One-shot: emails Scott the main-rig Headscale-client setup steps.
// Reads PROTON_BRIDGE_USERNAME / PASSWORD from /home/jorgenclaw/NanoClaw/.env,
// sends through the local Proton Bridge SMTP (127.0.0.1:1025).

import fs from 'node:fs';
import path from 'node:path';
import { sendMessage } from './mail/smtp-client.js';

const ENV_PATH = '/home/jorgenclaw/NanoClaw/.env';
const env = Object.fromEntries(
  fs.readFileSync(ENV_PATH, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    })
);

const username = env.PROTON_BRIDGE_USERNAME;
const password = env.PROTON_BRIDGE_PASSWORD;
if (!username || !password) {
  console.error('Missing PROTON_BRIDGE_USERNAME or PROTON_BRIDGE_PASSWORD in .env');
  process.exit(1);
}

const config = {
  username,
  password,
  smtp_host: '127.0.0.1',
  smtp_port: 1025,
};

const PREAUTH_KEY = 'hskey-auth-BKtO-TZTMPxe-M7eDrYsWREju_hrAp6pWuSWk9GaN3P5zo-u3vYlPvY6icBGsgizUKXfu1x17p2Q3';
const HEADSCALE_URL = 'http://192.168.9.144:8080';

const subject = 'Connecting your main rig to Headscale (open-source mesh VPN)';

const body = `Connecting your main rig to Headscale
=====================================

What this is
------------
The EVO box is now running Headscale — your self-hosted, open-source replacement for Tailscale's corporate coordination server. Headscale is MIT-licensed; the data tunnel is WireGuard (also open source); the only proprietary piece in the picture (Tailscale Inc.'s SaaS) has been removed from the loop.

This email walks you through installing the Tailscale CLIENT on your main rig (the client is BSD-3 open source, fine to use) and pointing it at YOUR Headscale on the EVO box, instead of tailscale.com.

End state: both machines on a private mesh network with stable addresses (100.64.0.x) regardless of which physical network either is on.


Before you start
----------------
ProtonVPN consideration. Your home network routes everything through San Jose. If ProtonVPN is running on the main rig with full-tunnel mode, the main rig won't be able to reach 192.168.9.144 (a private LAN address) — its packets get sent to SJC instead.

Two options:
  - Easier: in ProtonVPN settings, enable "Allow LAN connections" (or equivalent). This exempts 192.168.x.x from the VPN tunnel. Re-test after toggling.
  - Harder: if you can't enable LAN access, message me on Signal and we'll expose Headscale on a public hostname (hs.jorgenclaw.ai via Cloudflare Tunnel). That's ~30 min of extra setup.

What OS are you on? These instructions assume Linux (apt-based, like Pop!_OS or Ubuntu 24.04). If you're on Windows or macOS, the install command is different (download from tailscale.com/download, or 'brew install tailscale' on macOS) but the 'tailscale up' command in Step 2 is the same on all platforms.


Step 1 — Install the Tailscale client (Linux apt)
-------------------------------------------------
Save the block below to a file ~/install-tailscale.sh, then run:

    sudo bash ~/install-tailscale.sh

----- begin install-tailscale.sh -----
#!/usr/bin/env bash
set -euo pipefail

# Adjust CODENAME if you're not on Ubuntu 24.04 / Pop!_OS 24.04:
#   noble = 24.04, jammy = 22.04, oracular = 24.10
CODENAME="noble"

curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/\${CODENAME}.noarmor.gpg \\
  -o /usr/share/keyrings/tailscale-archive-keyring.gpg
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/\${CODENAME}.tailscale-keyring.list \\
  -o /etc/apt/sources.list.d/tailscale.list
apt-get update
apt-get install -y tailscale
tailscale version
----- end -----

(If you're on Arch: 'sudo pacman -S tailscale && sudo systemctl enable --now tailscaled'. The 'tailscale up' command in Step 2 is the same.)


Step 2 — Connect the main rig to Headscale
-------------------------------------------
Once the client is installed, run this exact command on the main rig:

    sudo tailscale up \\
      --login-server=${HEADSCALE_URL} \\
      --auth-key=${PREAUTH_KEY} \\
      --hostname=main-rig \\
      --accept-routes=false

What each flag does:
  --login-server   Points at YOUR Headscale on the EVO box (not tailscale.com).
  --auth-key       Pre-shared key Headscale generated. Reusable, valid 24 hours
                   from when this email was sent. If it expires before you get
                   to it, SSH into EVO and run:
                       sudo headscale preauthkeys create --user 1 \\
                            --reusable --expiration 24h
                   Then retry Step 2 with the new key.
  --hostname       What this device will be called in the headnet ("main-rig").
  --accept-routes  Off for now — we don't need subnet route advertisement yet.

If it succeeds, the command returns silently to a prompt. Run:

    tailscale ip -4

You should see "100.64.0.2" (or similar 100.64.0.x — second device on the headnet, EVO is .1).


Step 3 — Verify the mesh works
------------------------------
On the main rig:

    tailscale status
    ping -c 3 100.64.0.1

Expected output:
  - 'tailscale status' lists both devices: 'evo' (100.64.0.1) and 'main-rig' (100.64.0.2).
  - 'ping 100.64.0.1' returns responses (not 100% loss).

If both work, you're done. The mesh is live and we're off Tailscale's corporate SaaS entirely.


Troubleshooting
---------------
Problem: 'tailscale up' hangs forever
  What it means: Main rig can't reach 192.168.9.144. ProtonVPN is most likely blocking LAN traffic.
  What to do:    Enable "Allow LAN connections" in ProtonVPN, OR ping me on Signal to set up Cloudflare Tunnel + hs.jorgenclaw.ai.

Problem: 'Auth key expired'
  What it means: The 24-hour preauth key timed out before you ran Step 2.
  What to do:    SSH into EVO. Run 'sudo headscale preauthkeys create --user 1 --reusable --expiration 24h' to mint a fresh one. Retry Step 2 with the new key.

Problem: '400 Bad Request' or 'unsupported version' from server
  What it means: Tailscale client and Headscale server disagree on protocol version.
  What to do:    EVO is running Headscale 0.28.0. Make sure 'tailscale --version' on the main rig is 1.96 or newer. If older, upgrade via 'sudo apt-get update && sudo apt-get install --only-upgrade tailscale'.

Problem: Both devices show in 'tailscale status' but ping hangs
  What it means: NAT/firewall blocking direct WireGuard between peers — should auto-fall-back to a DERP relay but maybe not.
  What to do:    Run 'tailscale netcheck' on both. Look for "DERP latency" — if missing, your ISP may block UDP outbound. Worst case, we self-host a DERP server on EVO (separate task).


What's next (after both ends are connected)
-------------------------------------------
Message me on Signal "main rig is on the headnet" and I'll walk you through:
  1. Installing LiteLLM on the main rig (translates Anthropic API → Ollama).
  2. Locking LiteLLM to listen ONLY on the headnet IP (100.64.0.2), so the open internet can't reach it.
  3. Setting up Headscale ACLs so only EVO can talk to LiteLLM on port 4000.
  4. Wiring a NanoClaw 'private' group to that endpoint, so messages there go to your local Ollama instead of Anthropic.

Once that's done, conversations in the private group never leave your house.

---

Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct prompting and verification from Scott Jorgensen.
`;

try {
  const result = await sendMessage(config, {
    to: 'scott@jorgenclaw.ai',
    subject,
    body,
  });
  console.log('Sent:', result.message_id);
} catch (err) {
  console.error('Send failed:', err.message);
  process.exit(1);
}
