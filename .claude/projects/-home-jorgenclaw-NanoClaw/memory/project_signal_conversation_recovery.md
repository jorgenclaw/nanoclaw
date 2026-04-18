---
name: Signal conversation recovery needed
description: 3-day gap in conversation data (April 16-18 2026) after V2 migration data loss — recover from Signal phone export
type: project
---

During V2 migration on 2026-04-18, `groups/` and `store/` directories were accidentally destroyed by `git reset --hard` to a commit that had circular symlinks. Data restored from USB backup dated 2026-04-15 23:59.

**Gap:** April 16 00:00 → April 18 ~16:00 (approximately 3 days of conversation data missing from `store/messages.db`)

**Recovery plan:**
- Export Signal conversations from Scott's phone for the gap period (April 16-18)
- Import into `store/messages.db` messages table to fill the gap
- Signal desktop or signal-cli may also have local message history that can be extracted
- Focus on the `main` group (Scott's DM) and any active contact conversations during that period
- The V2 central DB (`data/v2.db`) is fine — it was freshly populated from the restored V1 DB

**Why:** This ensures Jorgenclaw's conversation memory files and daily summaries have continuity. The nightly consolidation task would have written summaries for April 16-17 that are now missing from `groups/main/conversations/`.

**How to apply:** When Scott is ready, investigate signal-cli's local message store at `~/.local/share/signal-cli/data/` for cached messages from the gap period. Alternatively, export from Signal mobile app.
