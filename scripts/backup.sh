#!/bin/bash
# NanoClaw USB backup — runs nightly at 23:59 via cron
set -e

BACKUP_MOUNT="/media/jorgenclaw/NanoClaw"
PROJECT="/home/jorgenclaw/NanoClaw"
LOG="$PROJECT/logs/backup.log"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR="$BACKUP_MOUNT/backups/$TIMESTAMP"
RETENTION_DAYS=30

mkdir -p "$(dirname "$LOG")"

{
  echo "=== Backup started: $(date) ==="

  if [ ! -d "$BACKUP_MOUNT" ]; then
    echo "USB drive not mounted at $BACKUP_MOUNT — skipping"
    exit 0
  fi

  mkdir -p "$BACKUP_DIR"

  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='*.sock' \
    "$PROJECT/store/" "$BACKUP_DIR/store/"

  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='*.sock' \
    "$PROJECT/groups/" "$BACKUP_DIR/groups/"

  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='*.sock' \
    "$PROJECT/data/" "$BACKUP_DIR/data/"

  # Prune old backups
  find "$BACKUP_MOUNT/backups" -maxdepth 1 -type d -mtime +$RETENTION_DAYS -exec rm -rf {} \;

  echo "=== Backup complete: $BACKUP_DIR ==="
} >> "$LOG" 2>&1
