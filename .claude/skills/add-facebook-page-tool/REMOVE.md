# Remove Facebook Page Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had it wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name facebook
```

For a multi-Page install, remove each `facebook_<slug>` server instead, then
the mount (`ncl groups config remove-mount`), the `~/.facebook-pages`
allowlist entry, and the token files (`rm -rf ~/.facebook-pages`).

## 2. Restart affected containers

```bash
ncl groups restart --id <group-id>
```

## 3. Delete the vendored source

```bash
rm -rf container/agent-runner/src/facebook-mcp
```

No Dockerfile edits to revert and no image rebuild needed — this skill never
touched either (see SKILL.md Phase 2).

## 4. Optional: remove the vaulted token

```bash
FB_SECRET_ID=$(onecli secrets list | jq -r '.data[] | select(.name == "Facebook Page Token") | .id')
onecli secrets delete --id "$FB_SECRET_ID"
```

Only do this if no other group still uses the same secret.

## 5. Optional: revoke the Meta token itself

On business.facebook.com → Business Settings → Users → System Users → the
token's System User → revoke the generated token, or delete the System User
entirely if it was created solely for this.

## Verification

After removal, a previously-wired agent asked to "list Facebook posts"
should report no Facebook tool available:

```bash
ls container/agent-runner/src/facebook-mcp 2>&1   # No such file or directory
```
