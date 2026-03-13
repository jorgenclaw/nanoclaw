# White Noise Channel Setup

This guide walks you through setting up White Noise — an end-to-end encrypted messaging channel for NanoClaw that runs on the Nostr network using the MLS protocol. It's like Signal, but decentralized.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next. You can say something like "I'm on step 4 of the White Noise setup and I'm confused" and Claude will help you figure out what's going on.

## What You're Setting Up

There are two programs that work together:

- **`wnd`** — a background daemon (like a server) that stays connected to the Nostr network, manages your encryption keys, and handles messages. It runs automatically when your computer starts.
- **`wn`** — a command-line tool you type manually to do things like login, list groups, and send messages. It talks to `wnd` through a socket file.

NanoClaw connects to `wnd` through `wn` to send and receive encrypted messages.

**Images work too** — when someone sends a picture to a White Noise group, NanoClaw automatically downloads it and the agent can view it, just like with Signal.

## Where Things Live

| What | Where on your computer |
|------|------------------------|
| `wn` and `wnd` shortcuts | `~/.local/bin/wn` and `~/.local/bin/wnd` (these are symlinks to the real binaries) |
| The actual compiled programs | `~/whitenoise-rs/target/release/` |
| wnd's data (keys, databases) | `~/.local/share/whitenoise-cli/` |
| Downloaded images/media | `~/.local/share/whitenoise-cli/release/media_cache/` |
| The socket file (how `wn` talks to `wnd`) | `~/.local/share/whitenoise-cli/release/wnd.sock` |
| wnd's logs | `~/.local/share/whitenoise-cli/logs/` |
| The systemd service file | `~/.config/systemd/user/wnd.service` |

---

## First-Time Setup

### 1. Build whitenoise-rs from source

You need Rust installed (`rustup`) for this. These commands download the source code and compile it:

```bash
cd ~
git clone https://github.com/nickkjolsing/whitenoise-rs.git
cd whitenoise-rs
cargo build --release
```

This takes a few minutes. When it finishes, you'll have two new programs in `~/whitenoise-rs/target/release/`: `wnd` and `wn`.

### 2. Make `wn` and `wnd` available as commands

On some Linux systems, typing `wn` runs a program called WordNet instead of the White Noise CLI. To fix this, we create symlinks (shortcuts) in `~/.local/bin/`, which takes priority:

```bash
ln -sf ~/whitenoise-rs/target/release/wn  ~/.local/bin/wn
ln -sf ~/whitenoise-rs/target/release/wnd ~/.local/bin/wnd
```

Now test it:

```bash
wn --help
```

You should see White Noise help output, **not** WordNet. If you still see WordNet, add this line to the bottom of your `~/.bashrc` file and then open a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3. Create the wnd background service

This tells your computer to automatically start `wnd` whenever you log in, so you don't have to remember to start it yourself.

Create the file `~/.config/systemd/user/wnd.service` with this content:

```ini
[Unit]
Description=White Noise daemon (wnd)
After=network-online.target
Before=nanoclaw.service

[Service]
Type=simple
ExecStart=%h/.local/bin/wnd --data-dir %h/.local/share/whitenoise-cli --logs-dir %h/.local/share/whitenoise-cli/logs
Restart=on-failure
RestartSec=5
Environment=HOME=%h

[Install]
WantedBy=default.target
```

> **What's `%h`?** It's systemd's shorthand for your home directory (e.g., `/home/scott`). This means you don't have to hardcode your username — the file works for anyone.

Now tell systemd about the new service and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now wnd
```

Check that it's running:

```bash
systemctl --user status wnd
```

You should see `Active: active (running)` in green.

> **Warning:** Never run `wnd` manually (like `~/whitenoise-rs/target/release/wnd ...`) while the systemd service is enabled. Two `wnd` processes will fight over the socket file and both will crash repeatedly. Always use `systemctl --user start/stop/restart wnd`.

### 4. Login with your nsec (your Nostr private key)

Your nsec is your Nostr identity — it starts with `nsec1...`. You need to paste it so `wnd` knows who you are.

```bash
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock login
```

It will ask you to paste your nsec. After you paste it and hit Enter, it prints your **hex pubkey** — a long string of letters and numbers. **Copy and save this pubkey somewhere** (like in a notes app or password manager). You'll need it in the next step.

Now restart `wnd` so it picks up your new account:

```bash
systemctl --user restart wnd
```

### 5. Tell NanoClaw about your White Noise account

Open the `.env` file in the NanoClaw directory and add this line (replace the placeholder with your actual hex pubkey from step 4):

```
WN_ACCOUNT_PUBKEY=<your hex pubkey from step 4>
```

NanoClaw will automatically connect to White Noise when it sees this setting.

### 6. Make sure NanoClaw starts after wnd

Edit the file `~/.config/systemd/user/nanoclaw.service` and find the `After=` line. Make sure it includes `wnd.service`:

```
After=network.target wnd.service
```

This ensures NanoClaw waits for `wnd` to be ready before starting. Then reload systemd so it picks up the change:

```bash
systemctl --user daemon-reload
```

### 7. Build a container-compatible wn binary (optional — skip if unsure)

This is only needed if your NanoClaw agent containers need to run `wn` commands directly. The binary you built on your host machine might not work inside a Docker container because they can use different system libraries.

```bash
docker run --rm -v ~/whitenoise-rs:/src -w /src \
  node:22-slim \
  bash -c "apt-get update && apt-get install -y build-essential curl && \
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && \
    . ~/.cargo/env && cargo build --release"
```

### 8. Build and restart NanoClaw

Compile the latest code and restart the service:

```bash
cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw
```

### 9. Register a White Noise group

After someone creates a group on White Noise and adds your npub, the group won't show up in NanoClaw automatically. You need to:

1. Wait for a message to arrive in the group
2. Find the group's **MLS group ID** — this is the ID NanoClaw uses internally

To find it, run this command (replace `<pubkey>` with your hex pubkey):

```bash
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock \
  --json --account <pubkey> groups list
```

This outputs JSON with a `mls_group_id` field containing a `vec` array of numbers. You need to convert those numbers to a hex string. Ask Claude to do it for you, or use this one-liner:

```bash
# Paste the vec array numbers here, separated by commas:
python3 -c "arr = [209,50,3,5,...]; print(''.join(f'{b:02x}' for b in arr))"
```

The resulting hex string (e.g., `d132030571da7d9ccd61f8694463b450`) is your group ID. The NanoClaw JID is `whitenoise:<that hex string>`.

> **Important:** There are two different group IDs in the JSON — the `nostr_group_id` and the `mls_group_id`. You need the **MLS group ID** (the shorter one). If you use the wrong one, you'll get a "Group not found" error when trying to send messages.

3. Register it in NanoClaw's database, just like you would for a Signal group

### 10. Create the group folder

Each registered group needs a folder on disk for its memory and logs:

```bash
mkdir -p groups/<folder-name>/logs
```

Replace `<folder-name>` with something descriptive, like `whitenoise-test` or `family`.

---

## After a Reboot

If you completed steps 3 and 6, **both wnd and NanoClaw start automatically when you log in**. You shouldn't need to do anything.

To double-check everything is healthy:

```bash
systemctl --user status wnd        # should say "active (running)"
systemctl --user status nanoclaw   # should say "active (running)"
tail -20 ~/NanoClaw/logs/nanoclaw.log  # look for "White Noise channel connected (polling mode)"
```

### The MLS database encryption key problem (and how to fix it)

This is the most common issue after a reboot. Here's what happens:

When `wnd` first starts, it creates an encrypted database to store your group information and messages. The key to decrypt that database is stored in your system's **desktop keyring** — a password vault that lives in RAM. **The keyring is wiped every time you reboot.** So after a reboot, the encrypted database still exists, but the key to open it is gone.

You'll know this happened if `wnd` is crash-looping and the logs show: `"no encryption key found in keyring"`.

**The fix — full recovery procedure:**

This looks like a lot of steps, but it boils down to: clean everything out, re-login, and recreate your groups.

```bash
# Step 1: Stop wnd
systemctl --user stop wnd

# Step 2: Logout your account (so wnd forgets the old state completely)
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock \
  logout <YOUR_PUBKEY_HEX>

# Step 3: Delete the old encrypted database that can't be opened anymore
rm -rf ~/.local/share/whitenoise-cli/release/mls/

# Step 4: Start wnd fresh (it will start clean with no accounts)
systemctl --user start wnd

# Step 5: Wait a few seconds for wnd to finish starting
sleep 5

# Step 6: Re-login with your nsec
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock login
# (paste your nsec when prompted)

# Step 7: Restart wnd so it picks up your re-added account
systemctl --user restart wnd
```

**After re-login, wait 2–3 minutes before creating groups.** Here's why:

When you login, `wnd` publishes something called a **key package** to the Nostr relays. Think of a key package like a one-time mailbox key — when someone wants to invite you to a group, they grab your key package from a relay and use it to encrypt the invitation so only you can read it. If you create a group immediately after login, the app might still have an old (stale) key package cached, and the invitation will fail with `"No matching key package found in the key store"`.

**After waiting, create a brand new group from the WN app and send a message.** Old groups from before the reboot won't work — they were tied to the old MLS state. You need fresh groups.

Then restart NanoClaw so it picks up the new group:

```bash
cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw
```

### Manual restart (if something isn't running)

```bash
systemctl --user start wnd       # start wnd first
sleep 3                           # give it a moment to create the socket
systemctl --user start nanoclaw   # then start NanoClaw
```

### Troubleshooting

| Problem | What it means | What to do |
|---------|---------------|------------|
| wnd won't start | Something is wrong with the daemon | Check logs: `journalctl --user -u wnd --no-pager -n 20` |
| "daemon already running" in logs | A stale wnd process from a previous restart is still alive, holding the socket | Find it: `ps aux \| grep wnd`, kill it: `kill <PID>`, then: `systemctl --user start wnd` |
| NanoClaw says "daemon not running" | NanoClaw started before wnd was ready | Just restart NanoClaw: `systemctl --user restart nanoclaw` |
| "no encryption key found in keyring" | Reboot wiped the MLS database key | Follow the full recovery procedure above |
| "No matching key package" on group invites | You're trying to join a group using stale key packages from before the MLS reset | Do the full recovery procedure above, then **wait 2–3 minutes** before creating a new group from the app |
| "unknown version: 48" or similar giftwrap error | Your `wn`/`wnd` version is older than the WN mobile app, causing a protocol mismatch | Update whitenoise-rs — see "Keeping whitenoise-rs Updated" below |
| Images not showing in chat | NanoClaw code or whitenoise-rs may be outdated | Update whitenoise-rs, then `cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw` |

---

## Health Alerts

NanoClaw monitors the White Noise connection in the background. If polling fails **3 times in a row**, it triggers a health alert that gets sent to your fallback channel (typically Signal). You'll get a message like:

> "White Noise polling failed 3 times: [error details]"

This means you don't need to manually watch the logs — if WN goes down, you'll hear about it on Signal. When polling recovers, the alert clears automatically.

---

## Keeping whitenoise-rs Updated

The White Noise mobile app gets updated regularly. If your `wn`/`wnd` binaries are built from older source code, you can get protocol mismatches — errors like `"unknown version: 48"` when processing messages. Keep your CLI in sync with the app.

To update:

```bash
# 1. Pull the latest source code
cd ~/whitenoise-rs
git pull origin master

# 2. Rebuild (takes a couple minutes)
cargo build --release

# 3. Restart wnd to use the new binary
#    (the symlinks in ~/.local/bin/ point to the same files, so they update automatically)
systemctl --user stop wnd
sleep 2
systemctl --user start wnd

# 4. Rebuild and restart NanoClaw too
cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw
```

**How often should you update?** Check whenever something stops working — especially if you've recently updated the WN mobile app. You can also check proactively:

```bash
cd ~/whitenoise-rs && git fetch origin master && git log HEAD..origin/master --oneline
```

If that shows new commits, there's an update available.

---

## How Messages Work: Polling Mode

White Noise has a notification system (`wn notifications subscribe`), but it's unreliable — messages get dropped. Instead, NanoClaw **polls** for new messages every 3 seconds by running `wn messages list <group_id>` for each registered White Noise group. This is slower but much more reliable.

---

## Rotating Your Nostr Key

Changing your nsec means you get a new identity. Because White Noise groups are tied to your identity through the MLS protocol, **a new key means new groups** — you can't keep the old ones.

1. Login with the new key:
   ```bash
   wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock login
   ```
2. Logout the old account:
   ```bash
   wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock logout <OLD_PUBKEY>
   ```
3. Restart wnd: `systemctl --user restart wnd`
4. Update `WN_ACCOUNT_PUBKEY` in your `.env` file with the new pubkey
5. Update the group JID in NanoClaw's database (ask Claude for help with this)
6. Rebuild and restart: `cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw`

See also: [keyring-management.md](keyring-management.md) for storing your nsec securely in kernel memory.

---

## wn Command Reference

Every `wn` command needs the `--socket` flag so it knows how to talk to `wnd`. The socket path is always the same:

```
~/.local/share/whitenoise-cli/release/wnd.sock
```

If you get tired of typing it, you can add an alias to your `~/.bashrc`:

```bash
alias wnc='wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock'
```

Then use `wnc` instead of the full command.

| What you want to do | Command |
|---------------------|---------|
| Login with your nsec | `wn --socket <sock> login` |
| Logout an account | `wn --socket <sock> logout <PUBKEY>` |
| See who you're logged in as | `wn --socket <sock> whoami` |
| List all logged-in accounts | `wn --socket <sock> accounts list` |
| List your groups | `wn --socket <sock> groups list` |
| List groups as JSON (for finding group IDs) | `wn --socket <sock> --json --account <pubkey> groups list` |
| Read messages in a group | `wn --socket <sock> messages list <GROUP_ID>` |
| Send a message to a group | `wn --socket <sock> messages send <GROUP_ID> "your message"` |
| Download media from a group | `wn --socket <sock> media download <GROUP_ID> <FILE_HASH>` |

Where `<sock>` is `~/.local/share/whitenoise-cli/release/wnd.sock` and `<GROUP_ID>` is the **MLS group ID** (hex).

### Managing the wnd service

| What you want to do | Command |
|---------------------|---------|
| Check if wnd is running | `systemctl --user status wnd` |
| Restart wnd | `systemctl --user restart wnd` |
| Stop wnd | `systemctl --user stop wnd` |
| Start wnd | `systemctl --user start wnd` |
| Watch wnd's logs in real time | `journalctl --user -u wnd -f` |
