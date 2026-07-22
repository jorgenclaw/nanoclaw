// Apply three changes to scheduled_tasks:
// 1. Clawstr 5am — add post-session Signal summary
// 2. MoltBook 5:30am — same
// 3. Sunday May 10 briefing — re-enable with shortened prompt (no section 1)
//    + remove the placeholder May 11 row (recurrence will regenerate it from May 10)
const Database = require('better-sqlite3');
const db = new Database('/home/jorgenclaw/NanoClaw/data/v2.db', { readonly: false });

const SCOTT_SIGNAL_DESTINATION = `Send Scott a brief Signal summary as soon as the posting is done.

- channel_type: \`signal\`
- platform_id: \`198c1cdb-8856-4ac7-9b84-a504a0017c79\`

Format: 2–3 short bullet lines. Each line: what was posted (with subclaw or thread name + nevent/note id if available) plus any flags (signer down, content held, relay error). If nothing was posted because nothing was worth saying, send a single line saying so.

Do NOT wait until later. Send the summary right after the posting step finishes, before this turn ends. This replaces the social-media section of the morning briefing — the briefing no longer summarizes Clawstr/MoltBook activity, so you are the source of record.`;

const NEW_CLAWSTR_PROMPT = `Clawstr 5am engagement session. Post rotating content from FOSS, sovereignty, Lightning topics if there is something worth saying. Start with "gm" if nothing substantial.

${SCOTT_SIGNAL_DESTINATION}`;

const NEW_MOLTBOOK_PROMPT = `Moltbook 5:30am session. Check notifications, engage thoughtfully, post if something is worth saying.

${SCOTT_SIGNAL_DESTINATION}`;

const NEW_BRIEFING_PROMPT = `Run the morning briefing for Scott. Keep it short — bullet points only, flag things that need attention.

The Clawstr 5am and MoltBook 5:30am sessions now DM Scott directly with their own summaries — do NOT include a social-media section in this briefing. Don't read \`/workspace/agent/conversations/\` or query Nostr relays for what was posted.

1. **Metals prices (Gold & Silver)** — fetch spot prices and track 3-day rolling average:
   \`\`\`bash
   curl -s "https://metals.live/api/v1/latest" 2>/dev/null
   \`\`\`
   Parse gold and silver prices (USD per troy oz). Store today's entry to \`/workspace/agent/data/metals-prices.jsonl\` as one JSON line: \`{"date":"YYYY-MM-DD","gold":XXXX.XX,"silver":XX.XX}\` — skip if today already logged. Read last 3 entries to compute 3-day averages. Show today's price, 3-day avg, and direction vs yesterday (↑/↓/→).

2. **Crypto prices (BTC, XMR, LTC)** — fetch spot prices and track 3-day rolling average:
   \`\`\`bash
   curl -s "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,monero,litecoin&vs_currencies=usd" 2>/dev/null
   \`\`\`
   Store today's entry to \`/workspace/agent/data/crypto-prices.jsonl\` as one JSON line: \`{"date":"YYYY-MM-DD","btc":XXXXX.XX,"xmr":XXX.XX,"ltc":XX.XX}\` — skip if today already logged. Read last 3 entries to compute 3-day averages. Show today's price, 3-day avg, and direction vs yesterday (↑/↓/→) for each coin.

3. **Upcoming deadlines** — read \`/workspace/agent/memory/ongoing.md\` and flag any items with deadlines in the next 1–3 days that need attention.

4. **Weather** — fetch a 3-day forecast for two locations:
   - Manteca, California
   - Mammoth Lakes, California (representative for Central Sierra)
   Use: \`curl -s "wttr.in/Manteca+CA?format=j1"\` and \`curl -s "wttr.in/Mammoth+Lakes+CA?format=j1"\` — include high/low temps and conditions for each day.

5. **Facebook activity (last 24h)** — read messages in \`Folders/fb-monitor\` (Proton mailbox via the \`proton\` MCP server, or raw IMAP at \`127.0.0.1:1143\` STARTTLS, login \`agent@jorgenclaw.ai\`, password from env \`PROTON_BRIDGE_PASSWORD\`). For every message with INTERNALDATE in the last 24 hours, extract sender (prefer the \`X-Simplelogin-Original-From\` header if present, otherwise \`From\`), subject, and a one-line summary of the body. Group results: (a) tags/mentions of Scott, (b) Messenger DMs from real people, (c) Marketplace replies, (d) Page activity if Scott admins any. Skip reactions, likes, birthday reminders, "people you may know," generic security boilerplate. **Read-only** — do not mark, move, or delete anything on the server. If nothing new, say "no new FB activity."

## Reply destination — IMPORTANT

Send this briefing as a Signal DM to Scott Jorgensen on his phone:
- channel_type: \`signal\`
- platform_id: \`198c1cdb-8856-4ac7-9b84-a504a0017c79\`

**Do NOT send to the T-Watch wearable** (channel_type=\`watch\`, platform_id=\`watch:device\`). The wrist watch cannot display a multi-section briefing. The wrist Watch is a *channel*, not where this briefing belongs. If you find yourself about to call \`send_message\` with \`channel_type=watch\`, stop and use \`signal\` instead.

## Formatting

Format the summary for Signal (no markdown headings, use *bold* with single asterisks, bullet points). Only flag things that need Scott's attention — skip items that are fine.`;

const tx = db.transaction(() => {
  // 1. Clawstr 5am — find pending series
  const clawstrSeries = 'task-1776956065123-clawstr';
  const clawstrUpdate = db.prepare(
    `UPDATE scheduled_tasks SET prompt = ?, updated_at = datetime('now') WHERE series_id = ? AND status IN ('pending', 'cancelled')`,
  ).run(NEW_CLAWSTR_PROMPT, clawstrSeries);
  console.log('Clawstr rows updated:', clawstrUpdate.changes);

  // 2. MoltBook 5:30am
  const moltbookSeries = 'task-1776956065154-moltbook';
  const moltbookUpdate = db.prepare(
    `UPDATE scheduled_tasks SET prompt = ?, updated_at = datetime('now') WHERE series_id = ? AND status IN ('pending', 'cancelled')`,
  ).run(NEW_MOLTBOOK_PROMPT, moltbookSeries);
  console.log('MoltBook rows updated:', moltbookUpdate.changes);

  // 3a. Reactivate Sunday's briefing with new shorter prompt
  const reactivate = db.prepare(
    `UPDATE scheduled_tasks SET status = 'pending', prompt = ?, updated_at = datetime('now') WHERE id = 'task-1778331660667-30im4b'`,
  ).run(NEW_BRIEFING_PROMPT);
  console.log('Sunday briefing reactivated:', reactivate.changes);

  // 3b. Remove the placeholder May 11 row — recurrence will regenerate it after Sunday fires
  const removePlaceholder = db.prepare(
    `DELETE FROM scheduled_tasks WHERE id = 'task-1778335071228-paused-skip'`,
  ).run();
  console.log('Placeholder May 11 removed:', removePlaceholder.changes);
});

tx();

console.log();
console.log('=== Verification ===');
const verify = db
  .prepare(
    `SELECT id, series_id, status, process_after, substr(prompt, 1, 90) as p_head FROM scheduled_tasks
     WHERE series_id IN ('task-1776956065123-clawstr', 'task-1776956065154-moltbook', 'task-1776555602083-af6f6a')
       AND status = 'pending'
     ORDER BY process_after`,
  )
  .all();
for (const r of verify) {
  console.log(' ', r.id);
  console.log('    series=' + r.series_id, 'fires=' + r.process_after);
  console.log('    prompt head:', r.p_head.replace(/\n/g, ' '));
  console.log();
}
