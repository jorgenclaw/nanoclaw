---
name: add-facebook-page-tool
description: Add Facebook Page posting, scheduling, comment reading/replying, and insights as an MCP tool, using a OneCLI-vaulted Meta System User Page token. Vendored code (not an npm dependency) — see lib/facebook-mcp/THIRD_PARTY_NOTICE.md for provenance and an audit of the alternatives. Use when the user wants an agent to post to or manage a Facebook Business Page. Does NOT cover Messenger DMs or real-time webhook-driven comment notifications — those need Meta App Review/Business Verification and are a separate, bigger build (see the plan doc referenced below).
---

# Add Facebook Page Tool

Gives an agent group `facebook_create_post`, `facebook_schedule_post`,
`facebook_edit_post`, `facebook_delete_post`, `facebook_get_posts`, `facebook_get_comments`,
`facebook_reply_comment`, `facebook_hide_comment`, and `facebook_get_insights`
tools for one or more Facebook Business Pages, via the Graph API. Posts can
carry a link, a public image URL, or a local photo or video file (`media_path`).

**This is the posting/polling half only.** It does not receive live
webhook push events (new comments, Messenger DMs) — comments are read by
polling `facebook_get_comments`, not pushed. Real-time push and Messenger
both need Meta Business Verification + a full App Review submission, which
is a separate follow-on (see
`groups/main/memory/plans/facebook-page-automation-2026-09-21.md` for the
full context and reasoning).

**Why vendored, not an npm dependency:** audited 5 open-source Facebook/Meta
Graph API MCP packages on 2026-09-21 (comparison in the plan doc above).
`lmtNoLimit/mcp-facebook` was the only one small enough to fully read and own
(597 LOC), MIT-licensed, with a clean dependency list and no design flaws
(one candidate returned Page access tokens directly into the model's own
context — disqualifying). Full provenance and the patches applied:
`lib/facebook-mcp/THIRD_PARTY_NOTICE.md`.

**Principle:** Do the work — don't tell the user to do it. Exception: Meta's
own app/token setup happens on Meta's website and genuinely requires the
account owner's hands.

## Phase 1: Pre-flight

### Check if already applied

```bash
test -d container/agent-runner/src/facebook-mcp && echo "INSTALLED" || echo "NOT_INSTALLED"
```

If `INSTALLED`, skip to Phase 3 (Meta App + Page Setup) unless you're
re-syncing source after an upstream skill update — then re-run Phase 2 first.

### Check OneCLI is working

```bash
onecli version 2>/dev/null && echo "ONECLI_OK" || echo "ONECLI_MISSING"
```

If `ONECLI_MISSING`, tell the user to run `/init-onecli` first, then retry.

## Phase 2: Install the Vendored MCP Server

Unlike an npm-package tool (Gmail, Calendar), there is **no Dockerfile edit
and no image rebuild** for this skill. `container/agent-runner/src/` is a
live read-only host mount into every agent container (see
`docs/build-and-runtime.md`) — a new file placed there is visible inside
already-running containers immediately, no rebuild required. The
`@modelcontextprotocol/sdk` and `zod` this code imports are already
dependencies of `container/agent-runner/package.json`, so nothing new needs
installing there either.

```bash
cp -r .claude/skills/add-facebook-page-tool/lib/facebook-mcp \
      container/agent-runner/src/facebook-mcp
```

Verify:

```bash
find container/agent-runner/src/facebook-mcp -name '*.ts' | wc -l   # 23 (17 source + 6 test)
```

Run the tests and typecheck (both must pass — this is real vendored source,
not an opaque binary, so it gets real tests, not a structural presence
guard):

```bash
cd container/agent-runner && bun test src/facebook-mcp/
cd .. && pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
```

**No wiring/registration test exists for Phase 4 below, by design.**
Registering the MCP server (`ncl groups config add-mcp-server`) is a write to
the central DB, not a line in the git tree — there's nothing for a test to
catch if the registration is dropped. Same precedent as `/add-gcal-tool`
(see its SKILL.md Phase 2). Verified at runtime instead (Phase 6).

## Phase 3: Meta App + Page Setup (operator does this on Meta's site)

This cannot be scripted — it's a one-time setup on developers.facebook.com
and business.facebook.com. Tell the user:

> 1. Go to **developers.facebook.com** → My Apps → Create App → type **Business**.
> 2. Add the **Pages API** product to the app.
> 3. Go to **business.facebook.com** → Business Settings → Users → **System Users** → Add. Give it a name like "NanoClaw" and the Employee role.
> 4. Under **Business Settings → Accounts → Pages**, make sure the target Page is added to this Business, and assign the System User Full Control access to it.
> 5. Back on the System User, click **Generate New Token**, pick the app from step 1, and select these permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `pages_manage_engagement`. Generate — this produces a **long-lived System User Page token that does not expire**. Copy it now, you won't see it again.
> 6. Get the **Page ID**: on the Page itself, About → Page Transparency, or `facebook.com/<page-name>/about`.
>
> **Heads up on Meta's review gate:** with the app in Development Mode and
> you as the app's admin, posting/reading/replying to your own Page's
> content should work without a formal App Review submission — but sources
> disagree on exactly where that line sits, and it can only really be
> confirmed by trying it. If a call comes back `(#10) Application does not
> have permission for this action` or similar, that permission needs
> Advanced Access via App Review before it'll work — not a bug in this tool.

## Phase 4: Vault the Token in OneCLI

Facebook/Meta is not in OneCLI's OAuth app catalog (only Google products,
GitHub, GitLab, Resend as of onecli 1.4.1) — this is a static, long-lived
token, so it uses the generic-secret pattern (`/add-vercel` is the other
skill using this same pattern):

```bash
onecli secrets create \
  --name "Facebook Page Token" \
  --type generic \
  --value "<SYSTEM_USER_PAGE_TOKEN>" \
  --host-pattern "graph.facebook.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"
```

Verify:

```bash
onecli secrets list | grep -i facebook
```

### Assign the secret to the target agent

```bash
onecli agents list   # find secretMode for the target agent
```

If `secretMode: all`, nothing more to do — it auto-injects. If `selective`:

```bash
FB_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name == "Facebook Page Token") | .id')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$FB_SECRET_ID" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
```

## Phase 5: Register the MCP Server for the Target Group

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name facebook \
  --command bun \
  --args '["run","/app/src/facebook-mcp/index.ts"]' \
  --env '{"FACEBOOK_PAGE_ID":"<real-page-id>","FACEBOOK_PAGE_ACCESS_TOKEN":"onecli-managed"}'
```

`FACEBOOK_PAGE_ID` is not a secret — the real Page ID goes here directly.
`FACEBOOK_PAGE_ACCESS_TOKEN` only needs to be a non-empty placeholder; the
real token is swapped in by the OneCLI gateway in flight based on the
`graph.facebook.com` host-pattern match from Phase 4, matching the
`Authorization` header this vendored client sends (see
`lib/facebook-mcp/THIRD_PARTY_NOTICE.md` for why that patch matters here).

No mount step is needed — unlike Gmail/Calendar, this client reads
credentials straight from env vars, no on-disk stub credential file to keep
in sync.

Optional: `FACEBOOK_MAX_WRITES_PER_HOUR` (default 20) caps posts/replies/
deletes per hour as a safety net against a runaway agent. Add it to the
`--env` JSON above if a different limit is wanted.

`container/agent-runner/src/providers/claude.ts` derives the tool allow-list
from the registered server names automatically
(`mcp__facebook__facebook_create_post` etc.) — no separate allowlist edit.

### Managing more than one Page

**Use this instead of Phase 4/5 when the agent manages two or more Pages.**

Meta needs a separate **Page token** for each Page — a System User token
alone gets `(#190) This method must be called with a Page Access Token`.
OneCLI can't hold several: it picks a secret by host (and optional path),
every Page token lives on `graph.facebook.com`, and comment IDs
(`<post>_<comment>`) don't include the Page ID, so no path pattern can tell
the Pages apart for comment replies and hides. And an agent in OneCLI's
`all` secret mode would receive a vaulted Page token too. So with several
Pages, each Page's token goes in its own file on a read-only mount that only
the target group gets, and **no Facebook secret goes in OneCLI.**

1. Derive each Page token from the System User token (its Page tokens don't
   expire either) and write one file per Page. Never print the tokens:

   ```bash
   umask 077; mkdir -p ~/.facebook-pages
   # SU_TOKEN read from the clipboard or stdin, never typed as an argument
   curl -s -H "Authorization: Bearer $SU_TOKEN" \
     "https://graph.facebook.com/v25.0/<page-id>?fields=access_token" \
     | jq -r .access_token | tr -d '\n' > ~/.facebook-pages/<slug>.token
   ```

   `GET /me/accounts?fields=id,name` with the same token lists the Pages
   and their IDs. Ask only for `id,name`, since the default fields include every
   Page token.

2. Allow the folder read-only in `~/.config/nanoclaw/mount-allowlist.json`,
   then mount it into the group:

   ```bash
   ncl groups config add-mount --id <group-id> --host '~/.facebook-pages' --container facebook-pages --ro
   ```

3. Register one server per Page:

   ```bash
   ncl groups config add-mcp-server --id <group-id> --name facebook_<slug> \
     --command bun --args '["run","/app/src/facebook-mcp/index.ts"]' \
     --env '{"FACEBOOK_PAGE_ID":"<page-id>","FACEBOOK_PAGE_ACCESS_TOKEN_FILE":"/workspace/extra/facebook-pages/<slug>.token","FACEBOOK_PAGE_LABEL":"<Page name>"}'
   ```

   `FACEBOOK_PAGE_LABEL` prefixes every tool description with
   `[Page: <Page name>]`, so the agent can tell which Page a tool acts on. The
   write cap (`FACEBOOK_MAX_WRITES_PER_HOUR`) applies to each Page separately.

4. Make sure OneCLI holds **no** secret for `graph.facebook.com`
   (`onecli secrets list`). One left there would overwrite every Page's
   `Authorization` header with that one token.

Tradeoff: the tokens are readable inside that group's container (like any
env-var credential), but no other group gets them.

## Phase 6: Restart the Container

```bash
ncl groups restart --id <group-id>
```

(Or, from a host shell: `docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill` and let it respawn on next message.)

## Phase 7: Verify

Send the agent a message like **"list the last 5 posts on the Page"**. First
call takes a couple seconds while the MCP server subprocess starts and
OneCLI does the credential injection.

Check logs if it's not working:

```bash
tail -100 logs/nanoclaw.log | grep -iE 'facebook|mcp'
```

Common signals:
- `Missing Facebook credentials` → the `--env` JSON in Phase 5 didn't land; re-check `ncl groups config get --id <group-id>`.
- `401`/`OAuthException` from `graph.facebook.com` → OneCLI isn't injecting; verify the agent's secret mode and that the secret's `host-pattern` is exactly `graph.facebook.com`.
- `(#10) Application does not have permission for this action` → that specific permission needs Advanced Access / App Review (see Phase 3's note) — not a wiring bug.
- Agent says it has no Facebook tools → the `facebook` MCP server isn't registered for this group, or the container is stale — re-run Phase 5/6.

## Removal

See [REMOVE.md](REMOVE.md).

## Credits & references

- **Vendored from:** [`lmtNoLimit/mcp-facebook`](https://github.com/lmtNoLimit/mcp-facebook) (MIT). Full provenance, changes made, and known limitations: `lib/facebook-mcp/THIRD_PARTY_NOTICE.md`.
- **Candidate audit:** `groups/main/memory/plans/facebook-page-automation-2026-09-21.md` — comparison against 4 other candidates and the reasoning for picking this one.
- **Skill pattern:** static-secret half follows `/add-vercel`; MCP-server-registration half follows `/add-gmail-tool`/`/add-gcal-tool`, minus the Dockerfile/mount steps those need and this one doesn't (see Phase 2).
