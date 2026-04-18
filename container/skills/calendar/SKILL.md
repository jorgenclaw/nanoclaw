---
name: add-calendar
description: Add CalDAV calendar integration to NanoClaw. Your agent can read upcoming events, create new calendar entries, and update or delete events — on any CalDAV server (Radicale, Nextcloud, Google Calendar, iCloud, Fastmail, and more).
---

# Add Calendar (CalDAV)

This skill connects your NanoClaw agent to a CalDAV calendar. The agent can check your schedule, add events, reschedule, and delete — all from the chat.

CalDAV is an open standard supported by virtually every calendar service. This skill works with any CalDAV server: self-hosted [Radicale](https://radicale.org), [Nextcloud](https://nextcloud.com), Google Calendar (via CalDAV bridge), Apple iCloud, Fastmail, and more.

## Phase 1: Pre-flight

### Check if already applied

Check whether `tools/caldav/` exists. If it does, skip to Phase 3.

### Requirements

- A CalDAV server (or access to an existing one — Google, iCloud, Nextcloud, Fastmail all support CalDAV)
- CalDAV URL, username, and password (or app-specific password if 2FA is enabled)

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: Which CalDAV server are you using?

Options:
- Self-hosted Radicale
- Nextcloud
- Google Calendar (via Google CalDAV)
- iCloud
- Fastmail
- Other (I'll provide the CalDAV URL)

Collect server type now. We'll get credentials in Phase 3.

## Phase 2: Apply Code Changes

### Ensure the Jorgenclaw remote

```bash
git remote -v
```

If `jorgenclaw` is missing, add it:

```bash
git remote add jorgenclaw https://github.com/jorgenclaw/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch jorgenclaw skill/calendar
git merge jorgenclaw/skill/calendar || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `tools/caldav/` — CalDAV client (create, read, update, delete events via HTTP)
- `tools/caldav/ical.js` — iCalendar (RFC 5545) event builder/parser
- `tools/caldav/bin/caldav-cli.js` — CLI for agent use
- `container/skills/calendar/SKILL.md` — agent instructions for scheduling operations
- `CALDAV_URL`, `CALDAV_USERNAME`, `CALDAV_PASSWORD`, `CALDAV_CALENDAR_NAME` added to `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Install dependencies

```bash
cd tools/caldav && npm install && cd ../..
```

### Validate

```bash
node tools/caldav/bin/caldav-cli.js --help
```

If it prints the command list, the install is clean.

## Phase 3: Setup

### Find your CalDAV URL

**Radicale (self-hosted):**
Your CalDAV URL is typically `http://localhost:5232/<username>/<calendar-name>/`
Example: `http://127.0.0.1:5232/scott/personal/`

**Google Calendar:**
1. Go to Google Calendar → Settings → [calendar name] → Integrate calendar
2. Look for the "Secret address in iCal format" — the base URL without the `.ics` is your CalDAV endpoint
URL format: `https://calendar.google.com/calendar/dav/<calendar-id>/events/`
Use an [App Password](https://myaccount.google.com/apppasswords) if 2FA is enabled.

**Nextcloud:**
URL format: `https://your-nextcloud.com/remote.php/dav/calendars/<username>/<calendar-name>/`

**iCloud:**
URL format: `https://caldav.icloud.com/`
Use an [App-Specific Password](https://support.apple.com/en-us/102654).

**Fastmail:**
URL format: `https://caldav.fastmail.com/dav/calendars/user/<email>/`

### Configure credentials

```bash
# Add to .env:
CALDAV_URL=https://your-caldav-server/path/to/calendar/
CALDAV_USERNAME=your-username
CALDAV_PASSWORD=your-password-or-app-password
CALDAV_CALENDAR_NAME=personal
CALDAV_TIMEZONE=America/Los_Angeles
```

Restart the container for env changes to take effect.

## Phase 4: Verify

### List upcoming events

```bash
node tools/caldav/bin/caldav-cli.js upcoming --days 7
```

This should print your next 7 days of events. If it connects and returns events (or an empty list if you have none), the skill is working.

### Create a test event

```bash
node tools/caldav/bin/caldav-cli.js create \
  --title "NanoClaw test event" \
  --start "2026-12-01T10:00:00" \
  --end "2026-12-01T11:00:00" \
  --description "Testing CalDAV integration"
```

Check your calendar app to confirm the event appeared. Then delete it:

```bash
node tools/caldav/bin/caldav-cli.js delete --title "NanoClaw test event"
```

## Phase 5: Using the skill

Your agent now has calendar capabilities described in `container/skills/calendar/SKILL.md`. The agent understands:

- Checking upcoming events for today, this week, or a date range
- Creating events with title, start/end time, description, location, and attendees
- Updating existing events (rescheduling, changing details)
- Deleting events
- Finding free/busy slots for scheduling

Ask the agent: *"What do I have tomorrow?"* or *"Schedule a team call for Friday at 2pm."*

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `401 Unauthorized` | Wrong credentials | Double-check username/password; use an app password if 2FA is on |
| `404 Not Found` on calendar URL | URL wrong or calendar doesn't exist | Verify the CalDAV URL with a CalDAV client like [Thunderbird](https://www.thunderbird.net) first |
| Events created but not visible in app | Sync delay or wrong calendar name | Check `CALDAV_CALENDAR_NAME`; force-sync in your calendar app |
| `ECONNREFUSED` on Radicale | Radicale not running | `sudo systemctl start radicale` or `radicale --storage-filesystem-folder ~/.radicale` |
| Google Calendar 403 | Need app password | Generate an App Password at myaccount.google.com/apppasswords |
| Timezone issues (events at wrong time) | `CALDAV_TIMEZONE` not set or wrong | Set it to your IANA timezone name (e.g., `America/New_York`) |
