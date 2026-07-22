/**
 * scripts/archive-conversations.ts — Daily conversation transcript archiver.
 *
 * Reads `messages_in` + `messages_out` from every session DB belonging to an
 * agent group, merges them in chronological order, and writes a plain-text
 * transcript to `groups/<folder>/conversations/<YYYY-MM-DD>-raw.md`.
 *
 * Why this exists: the Claude provider archives transcripts on context
 * compaction (`container/agent-runner/src/providers/claude.ts:217`). The
 * OpenCode provider does not. When `groups/main` switched to OpenCode +
 * Gemma for local-first inference, transcript archiving silently stopped,
 * and the nightly consolidation task started producing empty summaries —
 * it relies on transcript prose, not raw SQL it can't reliably write.
 *
 * This archiver is deterministic — no model in the loop. The consolidation
 * task reads what it produces and summarizes prose.
 *
 * Usage:
 *   pnpm exec tsx scripts/archive-conversations.ts                     # yesterday, main
 *   pnpm exec tsx scripts/archive-conversations.ts --date 2026-05-13
 *   pnpm exec tsx scripts/archive-conversations.ts --backfill 7
 *   pnpm exec tsx scripts/archive-conversations.ts --group lauren-scott
 *   pnpm exec tsx scripts/archive-conversations.ts --all-groups
 *   pnpm exec tsx scripts/archive-conversations.ts --dry-run --date 2026-05-13
 *
 * Date semantics: every date string is interpreted in the host's local
 * timezone (TZ=America/Los_Angeles on this box). The DB stores timestamps
 * in UTC, so this script converts each row's UTC timestamp into a PT
 * calendar date when filtering. The boundary between "May 13" and "May 14"
 * is midnight PT, not midnight UTC.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CENTRAL_DB = path.join(ROOT, 'data/v2.db');
const SESSIONS_DIR = path.join(ROOT, 'data/v2-sessions');
const GROUPS_DIR = path.join(ROOT, 'groups');

const SCOTT_UUID = '198c1cdb-8856-4ac7-9b84-a504a0017c79';

interface Args {
  date: string | null;
  groupFolder: string;
  backfillDays: number | null;
  allGroups: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { date: null, groupFolder: 'main', backfillDays: null, allGroups: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--date') out.date = args[++i] ?? '';
    else if (a === '--group') out.groupFolder = args[++i] ?? 'main';
    else if (a === '--backfill') out.backfillDays = parseInt(args[++i] ?? '0', 10);
    else if (a === '--all-groups') out.allGroups = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: archive-conversations [options]

  --date YYYY-MM-DD     Archive a specific PT date (default: yesterday PT).
  --group <folder>      Agent group folder (default: main).
  --backfill N          Archive each of the last N PT days.
  --all-groups          Run for every group in the central DB.
  --dry-run             Print intended outputs without writing.
  -h, --help            Show this help.`);
}

function ptDayOf(ts: string): string {
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function ptTimeOf(ts: string): string {
  const normalized = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatLocalDate(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function yesterdayPT(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  return formatLocalDate(yesterday);
}

interface RawRow {
  timestamp: string;
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  content: string;
}

interface Message {
  ts: string;
  source: 'in' | 'out';
  kind: string;
  channelType: string | null;
  platformId: string | null;
  sessionId: string;
  text: string;
  senderLabel: string;
}

function parseInbound(r: RawRow, sessId: string): Message {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(r.content) as Record<string, unknown>;
  } catch {
    /* leave empty */
  }
  let senderLabel = 'unknown';
  let text = '';

  if (r.kind === 'task') {
    senderLabel = 'Scheduled task';
    text = (content.prompt as string | undefined) ?? '';
  } else if (r.kind === 'chat') {
    if (r.channel_type === 'signal' && r.platform_id === SCOTT_UUID) {
      senderLabel = 'Scott';
    } else if (r.channel_type === 'agent' && content.sender === 'system') {
      senderLabel = 'Agent system';
    } else if (r.channel_type === 'agent') {
      senderLabel = `agent:${r.platform_id ?? '?'}`;
    } else if (r.channel_type === 'signal') {
      senderLabel = `signal:${r.platform_id ?? '?'}`;
    } else {
      senderLabel = r.channel_type ?? 'unknown';
    }
    text = ((content.text as string | undefined) ?? (content.prompt as string | undefined) ?? '').trim();
  } else {
    senderLabel = `[${r.kind}]`;
    text = JSON.stringify(content);
  }

  return {
    ts: r.timestamp,
    source: 'in',
    kind: r.kind,
    channelType: r.channel_type,
    platformId: r.platform_id,
    sessionId: sessId,
    text,
    senderLabel,
  };
}

function parseOutbound(r: RawRow, sessId: string, agentName: string): Message {
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(r.content) as Record<string, unknown>;
  } catch {
    /* leave empty */
  }
  let senderLabel = agentName;
  let text = '';

  if (r.kind === 'system') {
    senderLabel = 'System action';
    text = JSON.stringify(content);
  } else {
    text = ((content.text as string | undefined) ?? '').trim();
  }

  return {
    ts: r.timestamp,
    source: 'out',
    kind: r.kind,
    channelType: r.channel_type,
    platformId: r.platform_id,
    sessionId: sessId,
    text,
    senderLabel,
  };
}

function readMessagesForDate(agentGroupId: string, sessionIds: string[], dateStr: string, agentName: string): Message[] {
  // We pull a UTC range that's a superset of the PT day (PT-day ± 1 day worth
  // of timestamps would also catch overlap, but a 3-day UTC window is simpler
  // and still small). We then filter in JS by exact PT day.
  const queryDays = [-1, 0, 1].map((delta) => {
    const d = new Date(`${dateStr}T12:00:00-07:00`); // anchor in PT
    d.setDate(d.getDate() + delta);
    return d.toLocaleDateString('en-CA', { timeZone: 'UTC' });
  });

  const inClause = queryDays.map(() => '?').join(',');
  const all: Message[] = [];

  for (const sessId of sessionIds) {
    const inPath = path.join(SESSIONS_DIR, agentGroupId, sessId, 'inbound.db');
    if (fs.existsSync(inPath)) {
      const db = new Database(inPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT timestamp, kind, channel_type, platform_id, content
             FROM messages_in
             WHERE substr(timestamp, 1, 10) IN (${inClause})
             ORDER BY timestamp`,
          )
          .all(...queryDays) as RawRow[];
        for (const r of rows) {
          if (ptDayOf(r.timestamp) === dateStr) all.push(parseInbound(r, sessId));
        }
      } finally {
        db.close();
      }
    }

    const outPath = path.join(SESSIONS_DIR, agentGroupId, sessId, 'outbound.db');
    if (fs.existsSync(outPath)) {
      const db = new Database(outPath, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT timestamp, kind, channel_type, platform_id, content
             FROM messages_out
             WHERE substr(timestamp, 1, 10) IN (${inClause})
             ORDER BY timestamp`,
          )
          .all(...queryDays) as RawRow[];
        for (const r of rows) {
          if (ptDayOf(r.timestamp) === dateStr) all.push(parseOutbound(r, sessId, agentName));
        }
      } finally {
        db.close();
      }
    }
  }

  all.sort((a, b) => a.ts.localeCompare(b.ts));
  return all;
}

function renderTranscript(dateStr: string, msgs: Message[], sessionCount: number): string {
  const inboundCount = msgs.filter((m) => m.source === 'in').length;
  const outboundCount = msgs.filter((m) => m.source === 'out').length;
  const scottCount = msgs.filter((m) => m.senderLabel === 'Scott').length;
  const taskCount = msgs.filter((m) => m.kind === 'task').length;

  const generatedAt = new Date().toLocaleString('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const dayName = new Date(`${dateStr}T12:00:00-07:00`).toLocaleDateString('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
  });

  const lines: string[] = [];
  lines.push(`# Daily Transcript — ${dateStr} (${dayName})`);
  lines.push('');
  lines.push(`> Generated by host archiver at ${generatedAt} PT.`);
  lines.push(`> Sources: ${sessionCount} session DB${sessionCount === 1 ? '' : 's'}.`);
  lines.push(`> Counts: ${inboundCount} inbound (${scottCount} from Scott, ${taskCount} scheduled tasks), ${outboundCount} outbound.`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (msgs.length === 0) {
    lines.push('_No messages in this date range._');
    return lines.join('\n') + '\n';
  }

  for (const m of msgs) {
    const time = ptTimeOf(m.ts);
    const channelInfo = m.channelType ? ` ${m.channelType}` : '';
    const arrow = m.source === 'in' ? '→' : '←';
    lines.push(`**${m.senderLabel} [${time} PT${channelInfo}, ${arrow}]**:`);
    lines.push('');
    const text = m.text.length > 6000 ? m.text.slice(0, 6000) + '\n…[truncated, ' + (m.text.length - 6000) + ' chars omitted]' : m.text;
    lines.push(text || '_(empty)_');
    lines.push('');
  }

  return lines.join('\n');
}

interface GroupRow {
  id: string;
  name: string;
  folder: string;
}

function loadGroup(folder: string): { agentGroupId: string; agentName: string; sessionIds: string[] } | null {
  const central = new Database(CENTRAL_DB, { readonly: true });
  try {
    const group = central.prepare('SELECT id, name, folder FROM agent_groups WHERE folder = ?').get(folder) as GroupRow | undefined;
    if (!group) return null;
    const sessions = central.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').all(group.id) as { id: string }[];
    return { agentGroupId: group.id, agentName: group.name, sessionIds: sessions.map((s) => s.id) };
  } finally {
    central.close();
  }
}

function loadAllGroupFolders(): string[] {
  const central = new Database(CENTRAL_DB, { readonly: true });
  try {
    const rows = central.prepare('SELECT folder FROM agent_groups').all() as { folder: string }[];
    return rows.map((r) => r.folder);
  } finally {
    central.close();
  }
}

function main(): void {
  const args = parseArgs();

  const dates: string[] = [];
  if (args.backfillDays !== null) {
    if (!(args.backfillDays >= 1)) {
      console.error('--backfill requires a positive integer');
      process.exit(2);
    }
    for (let i = 1; i <= args.backfillDays; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(formatLocalDate(d));
    }
  } else if (args.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
      console.error(`--date must be YYYY-MM-DD, got: ${args.date}`);
      process.exit(2);
    }
    dates.push(args.date);
  } else {
    dates.push(yesterdayPT());
  }

  const groupFolders = args.allGroups ? loadAllGroupFolders() : [args.groupFolder];

  let archived = 0;
  let skipped = 0;
  for (const folder of groupFolders) {
    const g = loadGroup(folder);
    if (!g) {
      console.error(`Group folder not found: ${folder} — skipping`);
      skipped++;
      continue;
    }

    for (const date of dates) {
      const msgs = readMessagesForDate(g.agentGroupId, g.sessionIds, date, g.agentName);
      const body = renderTranscript(date, msgs, g.sessionIds.length);
      const outDir = path.join(GROUPS_DIR, folder, 'conversations');
      const outPath = path.join(outDir, `${date}-raw.md`);

      if (args.dryRun) {
        console.log(`[dry-run] ${outPath} — ${msgs.length} messages`);
        continue;
      }

      fs.mkdirSync(outDir, { recursive: true });
      const tmp = outPath + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, outPath);
      console.log(`${outPath} — ${msgs.length} messages`);
      archived++;
    }
  }

  if (!args.dryRun) {
    console.log(`\nArchived ${archived} transcript${archived === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} group${skipped === 1 ? '' : 's'}` : ''}.`);
  }
}

main();
