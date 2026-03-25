#!/bin/bash
# Kill nostr-mcp-server processes older than 2 hours.
# These are spawned by NanoClaw containers but can outlive them.
# Runs hourly via cron.

find /proc -maxdepth 1 -regex '/proc/[0-9]+' -type d 2>/dev/null | while read procdir; do
  pid=$(basename "$procdir")
  # Check if this is a node process running nostr-mcp-server
  cmdline=$(tr '\0' ' ' < "$procdir/cmdline" 2>/dev/null)
  if echo "$cmdline" | grep -q "nostr-mcp-server"; then
    # Get process age in seconds
    start_time=$(stat -c %Y "$procdir" 2>/dev/null)
    now=$(date +%s)
    age=$(( now - start_time ))
    # Kill if older than 7200 seconds (2 hours)
    if [ "$age" -gt 7200 ]; then
      kill "$pid" 2>/dev/null
      echo "$(date -Is) Killed stale nostr-mcp-server pid=$pid age=${age}s" >> /home/jorgenclaw/NanoClaw/logs/stale-mcp.log
    fi
  fi
done
