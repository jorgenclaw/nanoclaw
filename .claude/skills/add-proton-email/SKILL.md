---
name: add-proton-email
description: "Add Proton Mail email capabilities to NanoClaw. Installs email commands, approval gates, audit logging, and outreach templates. Runs on top of the Proton Bridge MCP server — no new host-side code needed."
---

# Add Proton Email Skill

Gives your NanoClaw container agent full email capabilities via Proton Mail. The agent can check mail, compose drafts, reply to threads, follow up on unanswered messages, and send from templates — all gated behind an approval workflow so nothing sends without your explicit OK.

## Prerequisites

- **Proton Mail account** with [Proton Bridge](https://proton.me/mail/bridge) running on the host
- **Proton MCP server** mounted in the container (provides `mcp__proton__mail__*` tools)

## What This Installs

- **Email commands** in the agent's CLAUDE.md — `email check`, `email draft`, `email reply`, `email follow-up`, `email send-template`
- **Approval gate** — every outgoing email is shown as a draft first; you must reply "send" before it goes out
- **Audit log** — all email actions logged to `logs/mail-audit.jsonl`
- **6 email templates** for outreach (customizable)
- **Autonomous mode** — optionally skip approval for the rest of a session

## Implementation Steps

Run all steps automatically. Only pause for user confirmation when noted.

### 1. Pre-flight

Check if already installed:

```bash
grep -c "## Email Skill" /workspace/group/CLAUDE.md 2>/dev/null
```

If found, report "Email skill already installed" and stop.

Verify Proton MCP is available by checking if `mcp__proton__mail__list_messages` is callable. If not, warn the user that the Proton MCP server needs to be mounted first.

### 2. Identify the sending address

Use `AskUserQuestion` to ask:

> What email address will the agent send from? (e.g., agent@yourdomain.com)

Also ask:

> What is the owner's name and contact info for template signatures? (e.g., "Jane Smith, jane@example.com, 555-123-4567")

These values will be used to customize the templates.

### 3. Append email skill section to CLAUDE.md

Read `/workspace/group/CLAUDE.md` and append the following section at the end:

```markdown
## Email Skill

You have access to Proton Mail via `mcp__proton__mail__*` tools.

### Rules
- NEVER send an email without showing a draft and receiving explicit user approval first
- ALWAYS prepend the autonomous agent disclosure line to outgoing email from the agent address
- ALWAYS log sends/replies/deletes to `/workspace/group/logs/mail-audit.jsonl`
- Check `/workspace/group/memory/contacts.md` before composing — personalize using any known context
- Templates live in `/workspace/group/email-templates/` — use them for outreach
- For delete and forward operations, require nonce confirmation: return a nonce, wait for user to echo it back within 5 minutes

### Approval gate (required for all write operations)
1. Compose full draft
2. Show via send_message: "*Draft email — approve to send*\nTo: ...\nSubject: ...\n\n[body]\n\nReply *send*, *revise: [feedback]*, or *cancel*"
3. Wait for reply before sending
4. Log outcome to `/workspace/group/logs/mail-audit.jsonl`

### Autonomous mode
User can say "send without asking for the rest of this session" → skip approval gate for subsequent emails this session only. Resets next session.

### Commands
- `email draft` — compose and show for approval
- `email reply --id <n>` — fetch thread, compose reply, show for approval
- `email follow-up --to <addr> --days 5` — check if replied, draft nudge if not
- `email check` — summarize unread, group by priority
- `email send-template --name <t> --to <addr> --vars "k=v,..."` — fill template, show for approval
```

### 4. Create email templates

Create the directory `/workspace/group/email-templates/` and write 6 default template files.

Each template uses frontmatter:

```yaml
---
name: template-name
subject: "Subject line with {variables}"
variables: [name, venue, date]
auto_approve: false
---
```

**Templates to create:**

1. **outreach-invite.md** — Initial outreach to a potential contact or venue. Professional-friendly tone. Variables: `name`, `venue`, `date`, `contact_title`.

2. **outreach-follow-up.md** — Gentle follow-up after initial outreach. Warm tone. Variables: `name`, `original_date`.

3. **meeting-confirmation.md** — Confirms a scheduled meeting date/time/location. Variables: `name`, `date`, `time`, `venue`, `address`.

4. **meeting-reminder.md** — Day-before reminder. Variables: `name`, `day`, `time`, `address`.

5. **follow-up-no-reply.md** — Generic check-in when no reply received. Variables: `name`, `original_subject`, `days`.

6. **welcome.md** — Welcome message for new registrants or contacts. Variables: `name`, `service_name`, `identifier`.

Customize each template body with the owner's name, contact info, and website URL collected in step 2. All templates must have `auto_approve: false`.

### 5. Create audit log

```bash
mkdir -p /workspace/group/logs
touch /workspace/group/logs/mail-audit.jsonl
```

### 6. Verify and report

Confirm:
- CLAUDE.md contains "## Email Skill"
- `/workspace/group/email-templates/` exists with 6 template files
- `/workspace/group/logs/mail-audit.jsonl` exists and is writable

Report to the user:

> Email skill installed. Available commands:
> - `email check` — summarize unread
> - `email draft` — compose with approval gate
> - `email reply --id <n>` — reply to a thread
> - `email follow-up --to <addr> --days 5` — nudge if no reply
> - `email send-template --name <t> --to <addr> --vars "k=v,..."` — use a template
>
> All outgoing email requires your approval before sending. Say "send without asking" to enable autonomous mode for the current session.

## Security Design

The approval gate is the primary safety mechanism:

- **Default: approval required.** Every outgoing email is composed, shown in full, and held until the user replies "send." This prevents the agent from sending anything the user hasn't reviewed.
- **Autonomous mode is opt-in and session-scoped.** The user must explicitly say "send without asking" to skip the gate. It resets automatically when the session ends.
- **Destructive operations require nonce confirmation.** Delete and forward operations return a random nonce that the user must echo back within 5 minutes — an additional safeguard against accidental or manipulated deletions.
- **Audit log is append-only.** All email actions (send, reply, delete, forward) are logged to `logs/mail-audit.jsonl` with timestamps, recipients, and subjects.
- **Agent disclosure is mandatory.** All outgoing email from the agent address includes a disclosure line identifying it as AI-composed.

## Tested With

- Proton Mail via Proton Bridge (IMAP/SMTP on localhost)
- NanoClaw v1.2.43 on Linux (bare-metal)
- Signal as the primary messaging channel (approval gate works via Signal DM)
