---
name: quad-inbox-status
description: List and triage all pending files in the quad-inbox directory, including deferred tasks.
user_invocable: true
---

# Quad Inbox Status

Show the full state of the quad-inbox without executing anything.

## Steps

### 1. Active tasks

List all `.md` files in `groups/main/quad-inbox/` (excluding `responses/` and `deferred/`). For each file, show:
- File name
- First heading or first line as description

If empty, say "No active tasks."

### 2. Deferred tasks

List all `.md` files in `groups/main/quad-inbox/deferred/`. For each file, show:
- File name
- First heading or first line as description

If empty, say "No deferred tasks."

### 3. Response reports

List all `.md` files directly in `groups/main/quad-inbox/responses/` (not `archive/`). For each file, show:
- File name
- First heading or first line as description
- Days since last modified, and its `**Status:**` line if it has one

Mark a report `stale` if it was last modified 14+ days ago and its Status does not start with Blocked, Deferred, or Open (the sweep rule from step 8 of `/quad-inbox`).

If empty, say "No pending reports."

### 4. Summary

Present the counts: "X active, Y deferred, Z reports (S stale), A archived." A = `.md` files in `responses/archive/` (0 if the folder doesn't exist).

If any reports are stale, offer to archive them. This skill is read-only, so only move them if the user agrees: `mkdir -p groups/main/quad-inbox/responses/archive`, then `mv` the stale reports into it.

If the user wants to move a task between active and deferred, do it with a simple `mv` command.
