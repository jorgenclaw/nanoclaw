#!/usr/bin/env node
// Follow-up email to Scott: Cloudflare Tunnel is now in place, so the main-rig
// command uses the public Headscale URL instead of the LAN IP. Auth key unchanged.

import fs from 'node:fs';
import { sendMessage } from './mail/smtp-client.js';

const env = Object.fromEntries(
  fs.readFileSync('/home/jorgenclaw/NanoClaw/.env', 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const config = {
  username: env.PROTON_BRIDGE_USERNAME,
  password: env.PROTON_BRIDGE_PASSWORD,
  smtp_host: '127.0.0.1',
  smtp_port: 1025,
};

const PREAUTH_KEY = 'hskey-auth-BKtO-TZTMPxe-M7eDrYsWREju_hrAp6pWuSWk9GaN3P5zo-u3vYlPvY6icBGsgizUKXfu1x17p2Q3';
const PUBLIC_URL = 'https://hs.jorgenclaw.ai';

const subject = '[Update] Main-rig Headscale connect — use public URL, not LAN IP';

const body = `Quick follow-up to the earlier email.

What changed
------------
You decided not to toggle ProtonVPN's "Allow LAN connections", so we set up the alternative path: Cloudflare Tunnel. Headscale on the EVO box is now reachable at a public HTTPS URL via Cloudflare's network. The data tunnel between machines (WireGuard) still goes peer-to-peer or via DERP — Cloudflare only sees the small JSON control plane.

End result for you: your earlier command needs ONE substitution. The auth key is unchanged.

Updated command for the main rig
--------------------------------
After installing the Tailscale client (Step 1 from the previous email — that part is unchanged), run:

    sudo tailscale up \\
      --login-server=${PUBLIC_URL} \\
      --auth-key=${PREAUTH_KEY} \\
      --hostname=main-rig \\
      --accept-routes=false

Compared to the previous email, the only change is:
  --login-server=http://192.168.9.144:8080  →  --login-server=${PUBLIC_URL}

Everything else (auth key, hostname, --accept-routes flag) is identical.

Why this is better
------------------
1. Works regardless of ProtonVPN — the URL is public, not LAN-private. No router/VPN config needed on your end.
2. HTTPS — TLS handled by Cloudflare's edge. Real cert, no browser warnings.
3. Works from anywhere — if you take your laptop to a coffee shop, it'll still connect to the headnet.
4. No new setup on your side — the EVO box runs cloudflared as a daemon. You don't have to install anything related to Cloudflare Tunnel on the main rig.

Verify, same as before
----------------------
    tailscale status            # should list 'evo' and 'main-rig'
    ping -c 3 100.64.0.1        # should reach EVO via the headnet

Troubleshooting if things don't work
------------------------------------
Problem: 'tailscale up' returns 'permission denied' or '401'
  What it means: the auth key may have expired (24h window from when it was generated).
  What to do:    SSH into EVO, run 'sudo headscale preauthkeys create --user 1 --reusable --expiration 24h', retry with the new key.

Problem: 'tailscale up' hangs or returns 'connection refused'
  What it means: For some reason the main rig can't reach https://hs.jorgenclaw.ai.
  What to do:    From the main rig run 'curl -fsS https://hs.jorgenclaw.ai/health'. Expected response: {"status":"pass"}. If that fails, ProtonVPN is doing something exotic — message me on Signal.

Problem: 'tailscale status' shows main-rig but not evo
  What it means: Headscale registered the main rig but EVO is offline or de-registered.
  What to do:    On EVO, 'tailscale status' should show evo as 100.64.0.1. If it doesn't, message me.

What's next
-----------
Once you can ping 100.64.0.1 from the main rig, we're done with networking. Reply on Signal with "main rig is on the headnet" and we move to LiteLLM + the private NanoClaw group.

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
