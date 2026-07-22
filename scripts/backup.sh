#!/bin/bash
# NanoClaw + local records USB backup — runs nightly at 23:59 via cron
#
# Two tiers, because they need different retention:
#   operational — NanoClaw + channel identity/session state. Dated full
#                 snapshots (exFAT has no hardlink support, so these can't
#                 be incremental), pruned after RETENTION_DAYS.
#   records     — business/tax/personal files (jorgenclaw.ai LLC receipts
#                 etc). Single additive mirror, no --delete, never pruned
#                 by this script — a file removed locally stays backed up.
set -e

BACKUP_MOUNT="/media/jorgenclaw/NanoClaw"
PROJECT="/home/jorgenclaw/NanoClaw"
LOG="$PROJECT/logs/backup.log"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
RETENTION_DAYS=14

mkdir -p "$(dirname "$LOG")"

{
  echo "=== Backup started: $(date) ==="

  if [ ! -d "$BACKUP_MOUNT" ]; then
    echo "USB drive not mounted at $BACKUP_MOUNT — skipping"
    exit 0
  fi

  OP_DIR="$BACKUP_MOUNT/backups/$TIMESTAMP"
  mkdir -p "$OP_DIR"

  for pair in \
    "$PROJECT/store:store" \
    "$PROJECT/groups:groups" \
    "$PROJECT/data:data" \
    "$HOME/.local/share/signal-cli:signal-cli" \
    "$HOME/.local/share/whitenoise-cli:whitenoise-cli"
  do
    src="${pair%%:*}"; name="${pair##*:}"
    if [ ! -d "$src" ]; then
      echo "Skipping $name — $src not found"
      continue
    fi
    rsync -a --delete --no-links \
      --exclude='node_modules' \
      --exclude='*.sock' \
      --exclude='/logs' \
      "$src/" "$OP_DIR/$name/"
  done

  find "$BACKUP_MOUNT/backups" -maxdepth 1 -type d -mtime +$RETENTION_DAYS -exec rm -rf {} \;

  RECORDS_DIR="$BACKUP_MOUNT/records"
  mkdir -p "$RECORDS_DIR"

  for pair in \
    "$HOME/Documents:Documents" \
    "$HOME/Downloads:Downloads" \
    "$HOME/Desktop:Desktop" \
    "$HOME/Pictures:Pictures" \
    "$HOME/jorgenclaw.ai:jorgenclaw.ai"
  do
    src="${pair%%:*}"; name="${pair##*:}"
    if [ ! -d "$src" ]; then
      echo "Skipping $name — $src not found"
      continue
    fi
    rsync -a --no-links \
      --exclude='node_modules' \
      --exclude='*.sock' \
      "$src/" "$RECORDS_DIR/$name/"
  done

  echo "=== Backup complete: operational=$OP_DIR records=$RECORDS_DIR ==="
} >> "$LOG" 2>&1
