# Scripts — wholesale port + drop decisions

## Custom scripts to copy

| Script | Purpose | Notes |
|---|---|---|
| `scripts/backup.sh` | NanoClaw USB HDD backup; cron at 23:59 daily; rsync of groups/, store/, data/; 30-day retention | Keep |
| `scripts/health-check-daemons.sh` | Host daemon health probe; writes JSON status for container agents to read via systemd timer | Keep |
| `scripts/publish-firmware.sh` | Publish T-Watch S3 firmware for OTA updates; builds binary, copies to data/watch-firmware/, writes version.json | Keep |

## Scripts to drop (V1 migration helpers, no longer relevant)

| Script | Reason |
|---|---|
| `scripts/migrate-v1-data.ts` | One-time V1 → V2 data migration (idempotent). V1→V2 is done; this script is dead weight. |
| `scripts/migrate-v1-tasks.ts` | Migrate V1 scheduled_tasks to V2. Same — done, drop. |

## Application steps in worktree

```bash
WORKTREE=/home/jorgenclaw/NanoClaw/.upgrade-worktree
SOURCE=/home/jorgenclaw/NanoClaw

# Copy keep-list scripts (don't overwrite upstream's scripts/ wholesale —
# upstream may have its own scripts; merge by file)
for script in backup.sh health-check-daemons.sh publish-firmware.sh; do
  cp "$SOURCE/scripts/$script" "$WORKTREE/scripts/"
  chmod +x "$WORKTREE/scripts/$script"
done

# Verify
ls -la "$WORKTREE/scripts/" | grep -E "backup|health-check|publish-firmware"

# Confirm V1 migration scripts are NOT present (upstream shouldn't have them either)
ls "$WORKTREE/scripts/" | grep -E "migrate-v1" && echo "WARN: V1 migration scripts still present" || echo "OK: V1 migration scripts dropped"
```

## scripts/backup.sh — environment requirements

- HDD mounted at `/media/jorgenclaw/NanoClaw` (UUID `FBBD-F248`, exFAT)
- `/etc/fstab` entry: `UUID=FBBD-F248 /media/jorgenclaw/NanoClaw exfat defaults,nofail,uid=1000,gid=1000 0 0`
- Cron entry: `59 23 * * * /home/jorgenclaw/NanoClaw/scripts/backup.sh >> /home/jorgenclaw/NanoClaw/logs/backup.log 2>&1`
- These are HOST-LEVEL configurations preserved by the migration (cron is in user crontab, fstab is in /etc/) — verify intact post-cutover.

## scripts/publish-firmware.sh — environment requirements

- T-Watch S3 firmware source repo (separate, not in NanoClaw)
- HTTP server endpoint for OTA distribution
- (Setup is host-level; script just builds + publishes)

## scripts/health-check-daemons.sh — environment requirements

- Watches: signal-cli, nostr-signer.service, ollama, cloudflared
- Output: `data/daemon-health.json` (data/ is preserved)
- systemd timer `health-check.timer` calls it every 5 min — verify timer survives migration (host-level systemd unit at `~/.config/systemd/user/health-check.timer`)
