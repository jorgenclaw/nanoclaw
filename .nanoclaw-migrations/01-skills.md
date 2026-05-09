# Skills — wholesale port + deprecation decisions

## How skills are sourced in NanoClaw v2

Most skills in `.claude/skills/` are *upstream-mirrored* — they live on `upstream/skill/<name>` branches and get installed via the appropriate install workflow (`/init`, `/setup`, the user-facing skill install commands). Scott's history shows **no formal skill-branch merges** (only one merge commit total, an upstream/main sync) — meaning these were either copied-without-merge or installed via an install-skill workflow that copies files.

For the migration's Upgrade phase: the worktree starts from clean `upstream/main`, which already contains the skill INFRASTRUCTURE (`.claude/skills/` directory + the standard install skills like `/setup`, `/init-first-agent`, etc.). What we need to port is:
1. **Skills that don't exist in upstream** (custom user-authored)
2. **Modifications to upstream skills** (if any — none flagged in this audit)

## Custom user-authored skills (wholesale port)

These don't exist on `upstream/skill/*` branches — they live only in Scott's local `.claude/skills/`. Copy wholesale:

| Skill | Files | LOC | Active | Action |
|---|---|---|---|---|
| `x-integration` | 34 | 3,842 | YES | **Copy `.claude/skills/x-integration/` wholesale.** This is the v2 X integration with 24 Playwright-based tools. Includes lib/ (chrome-detect, config, extract, locators), scripts/ (24 action scripts), agent.ts, host.ts, SKILL.md. |
| `quad-inbox` | 1 | 82 | YES | Copy `.claude/skills/quad-inbox/SKILL.md` |
| `quad-inbox-status` | 1 | 41 | YES | Copy `.claude/skills/quad-inbox-status/SKILL.md` |
| `test-pr` | 1 | 180 | YES | Copy `.claude/skills/test-pr/SKILL.md` |
| `update` | 2 | 255 | YES | Copy `.claude/skills/update/` wholesale |

## Drop (deprecated, do NOT port)

| Skill | Reason |
|---|---|
| `get-qodo-rules` | Last touched Feb 28, 2026. Superseded by current tooling. Drop. |
| `qodo-pr-resolver` | v0.3.0 (incomplete), last touched Feb 28. Drop. |

## Application steps in worktree

```bash
# From the upgrade-worktree
WORKTREE=/home/jorgenclaw/NanoClaw/.upgrade-worktree
SOURCE=/home/jorgenclaw/NanoClaw

mkdir -p "$WORKTREE/.claude/skills/"

# Custom skills wholesale
for skill in x-integration quad-inbox quad-inbox-status test-pr update; do
  cp -r "$SOURCE/.claude/skills/$skill" "$WORKTREE/.claude/skills/"
done

# (Skip get-qodo-rules and qodo-pr-resolver — deprecated)

# Verify
ls "$WORKTREE/.claude/skills/" | grep -E "x-integration|quad-inbox|test-pr|update"
```

## Inter-skill / install-time dependencies

- `x-integration` requires `pnpm` to spawn `tsx` for the Playwright scripts. Already in NanoClaw v2's standard tooling.
- `x-integration/scripts/setup.ts` runs interactive Playwright auth — Scott will need to re-run this once post-migration to refresh the browser profile (data lives in `data/x-browser-profile/`, which is preserved by the migration's data-dir-protection rule).
- `quad-inbox` and `quad-inbox-status` rely on `groups/main/quad-inbox/` directory existing. Already preserved.
- `test-pr` uses `git worktree` — no special setup needed.
- `update` is a wrapper around upstream-merge logic; verify the script paths after migration.

## What the upstream worktree should already have

Don't re-port these — they should be present from upstream/main:
- `add-*` skills (channel installs: discord, slack, telegram, signal, etc.)
- `init-*` skills (init, init-first-agent, init-onecli)
- `manage-channels`, `manage-mounts`
- `setup`, `customize`, `debug`
- `migrate-from-openclaw`, `migrate-nanoclaw`, `update-nanoclaw`
- `claw` (CLI tool install)

If any of these are missing from upstream/main after the worktree checkout, that's a sign of upstream divergence — flag for Scott.
