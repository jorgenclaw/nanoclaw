# Managing Your Agent's nsec in the Linux Kernel Keyring

This guide explains how to store your Nostr private key (nsec) in Linux kernel memory instead of in a file. This is **optional** — `wn login` already saves your credentials in wnd's data directory, so NanoClaw works without the keyring. The keyring is useful if you have scripts or automation that need to read the nsec programmatically, or if you just want the extra security of keeping it out of any file on disk.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next. Just describe what you're trying to accomplish and Claude will walk you through it.

## The Most Important Thing to Know

**The kernel keyring is wiped every time you reboot your computer.** This is by design — it lives in RAM, not on disk. After a reboot, you'll need to re-add your nsec to the keyring. See "Persistence Across Reboots" below for ways to make this less painful.

## What's a Keyring?

Think of it as a password vault built into the Linux kernel. Instead of storing secrets in files (where they could be read by programs — including AI agents), you store them in kernel memory where only specific commands can access them.

Each secret in the keyring gets a **key ID** — a number like `482319866`. You use this number to read or delete the key later. The key also has a **name** (like `wn_nsec`) so you can search for it.

## Quick Reference

| What you want to do | Command |
|----------------------|---------|
| Store your nsec | `keyctl add user wn_nsec "YOUR_NSEC_HERE" @u` |
| Find it by name | `keyctl search @u user wn_nsec` |
| List everything in keyring | `keyctl show @u` |
| Read the nsec value | `keyctl print <ID>` |
| Delete it | `keyctl unlink <ID> @u` |
| Install keyctl (if missing) | `sudo apt install -y keyutils` |

## Storing Your nsec

Replace `YOUR_NSEC_HERE` with your actual nsec (the one that starts with `nsec1...`):

```bash
keyctl add user wn_nsec "YOUR_NSEC_HERE" @u
```

This prints a number — that's your **key ID**. Save it somewhere safe (like your password manager) alongside a note like "NanoClaw kernel keyring ID."

## Finding Your Key Later

```bash
# Search by the name you gave it
keyctl search @u user wn_nsec

# Or list everything in your keyring to find it
keyctl show @u

# Check a key's metadata without revealing its value
keyctl describe <KEY_ID>
```

## Reading the Value

```bash
keyctl print <KEY_ID>
```

**Be careful:** This displays your nsec in plain text in the terminal. Only do this on a secure, local terminal. **Never run this inside a Claude session or a container** — the AI would be able to see your private key.

## Rotating to a New nsec

When you want to switch to a new Nostr identity:

```bash
# 1. Remove the old nsec from the keyring
keyctl unlink <OLD_KEY_ID> @u

# 2. Store the new one
keyctl add user wn_nsec "NEW_NSEC_HERE" @u
# (save the new key ID that gets printed)

# 3. Login to White Noise with the new nsec
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock login
# (paste your new nsec when it asks)

# 4. Logout the old account (use the OLD pubkey hex)
wn --socket ~/.local/share/whitenoise-cli/release/wnd.sock logout <OLD_PUBKEY_HEX>

# 5. Restart the wnd service
systemctl --user restart wnd

# 6. Update NanoClaw and restart
# First, edit .env and change WN_ACCOUNT_PUBKEY to your new hex pubkey
# Then rebuild and restart:
cd ~/NanoClaw && npm run build && systemctl --user restart nanoclaw
```

**Note:** A new nsec means a new identity, which means new MLS groups. You'll need to have someone re-create any White Noise groups and add your new npub.

## Deleting a Key

```bash
keyctl unlink <KEY_ID> @u
```

This is permanent — the key cannot be recovered once deleted.

## Persistence Across Reboots

Since the keyring is wiped on reboot, here are your options for getting the nsec back in after a restart:

### Option 1: Paste from your password manager (simplest, most secure)

Keep your nsec in Bitwarden (or whatever you use). After each reboot, open a terminal and paste:

```bash
keyctl add user wn_nsec "PASTE_YOUR_NSEC_HERE" @u
```

### Option 2: Auto-load from Bitwarden at login (convenient)

Add this to your `~/.bashrc` or a login script. It pulls the nsec from Bitwarden and loads it into the keyring automatically — the nsec never touches a file on disk:

```bash
bw get password "Jorgenclaw nsec" | xargs -I{} keyctl add user wn_nsec {} @u
```

> **Remember:** For normal NanoClaw operation, you probably don't need the keyring at all. Running `wn login` once stores your credentials in wnd's data directory (`~/.local/share/whitenoise-cli/`), and that persists across reboots. The keyring is for extra security or for scripts that need to read the nsec directly.

## Security Notes

- **Key IDs are safe to share** — knowing the number doesn't reveal the secret
- **The keyring protects against file-based snooping** — this is the main threat from AI agents that can read files on disk
- **Root access defeats the keyring** — if someone has root on your machine, they can read kernel memory too. But that's a much higher bar than reading a config file
- **Keep your password manager on a separate device** — store your nsec in your phone's password manager (like Bitwarden on your phone), not in a password manager running on the same host computer. If the host is compromised, a password manager running on it is compromised too. Your phone is a separate device with its own lock screen and security — that's the point
