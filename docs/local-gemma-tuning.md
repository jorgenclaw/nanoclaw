# Running Jorgenclaw on a Local Gemma 4 (31B) Model

A complete, reversible tuning guide for swapping the cloud Claude provider for a local Ollama-served Gemma 4 31B in a NanoClaw agent group. Captures every change made on the EVO-X2 machine in May 2026, including the rationale, the failure modes encountered, and the fixes shipped.

This document is meant to be **forkable** — anyone running NanoClaw with sufficient hardware (~64GB unified memory or ~32GB VRAM) should be able to follow it end-to-end and end up with a working local agent. The author's setup (EVO-X2 with AMD AI Max+ chip) is the reference; specific paths assume a Linux host (`pop-os` / Ubuntu).

If you skip ahead, the **[Revert procedure](#switching-between-claude-and-gemma)** at the bottom is one file edit + one container kill in either direction.

---

## Why local

- **Cost** — every turn costs zero API dollars. For an always-on agent that polls a watch, runs scheduled tasks, and periodically zaps Lightning, this matters.
- **Sovereignty** — no third-party logs of every conversation Scott has with his agent.
- **Latency** — Ollama on local hardware is ~5× faster than round-tripping to a cloud API for short turns, though more variable on long ones.
- **Tradeoffs** — a 31B local model is dumber than Claude. Expect more silent-failure modes, looser tool-use compliance, and occasional hallucination. The fixes in this guide harden against the common ones; the rest is just accepting a less polished agent in exchange for the three points above.

---

## Hardware reference

| Component | EVO-X2 used here | Comments |
|---|---|---|
| GPU/iGPU memory | AMD AI Max+ unified memory, 96 GB system + 64 GB VRAM-equivalent | Gemma 4 31B at q8_0 is ~57 GB in VRAM; 26 GB at q4 |
| Disk | NVMe | Each 31B model variant is ~30–60 GB |
| OS | Pop!_OS 24.04 (Ubuntu derivative) | Anything with systemd user services + Ollama support works |
| Ollama version | 0.x (latest at time of writing) | |

If you only have 8–16 GB VRAM, a 31B model won't fit. Use `gemma4:8b` or `qwen2.5:7b-coder` and adjust the Modelfile section accordingly. The structural changes in this guide (container.json, CLAUDE.local.md, MCP tooling) apply unchanged regardless of which Ollama model you pick.

---

## Step 1: Pick a base model and bake in the params

NanoClaw + OpenCode pass model parameters through to Ollama at inference time. Some of those — like temperature, num_predict, repeat_penalty — are deeply influential on small-model agent behavior. Encoding them in a custom Modelfile gives you one source of truth and makes the model swap cleanly via `ollama create`.

Start with the upstream model you want as a base. Gemma 4 31B is a strong choice for tool-use compliance and long-context reasoning at this size:

```bash
ollama pull gemma4:31b-it-q8_0
```

Then write a Modelfile in your home dir (`~/jorgenclaw.Modelfile`):

```dockerfile
FROM gemma4:31b-it-q8_0

# Sampling — keep deterministic structure-following while still allowing
# variety on creative turns. Tighter than Ollama's default 0.7.
PARAMETER temperature 0.2
PARAMETER top_k 64
PARAMETER top_p 0.9

# Anti-repeat — small models love to fall into "I'll just keep saying the same
# phrase" loops. repeat_penalty + repeat_last_n catches the common cycle lengths.
PARAMETER repeat_penalty 1.15
PARAMETER repeat_last_n 256

# Token cap — without this, a degraded inference state will generate forever
# until num_ctx fills up. 8192 is generous for any single agent turn yet
# bounds the worst-case latency at ~minutes instead of forever.
PARAMETER num_predict 8192

# Context — full 200K so long conversations and large CLAUDE.local.md/system
# prompts both fit. Drop to 32768 if VRAM is tight.
PARAMETER num_ctx 204800
```

Build the named model:

```bash
ollama create gemma4:31b-jorgenclaw -f ~/jorgenclaw.Modelfile
ollama show --modelfile gemma4:31b-jorgenclaw   # verify
```

> **Why a custom name?** When you tweak params later, recreating against the same name keeps your container.json reference stable. The NanoClaw OpenCode provider has an auto-wipe (see [Step 5](#step-5-host-side-fixes-in-srcprovidersopencodets)) that detects Modelfile changes and forces a fresh OpenCode session — so iterating params is safe.

---

## Step 2: Wire the agent group to OpenCode + Ollama

The provider switch lives in your group's `container.json`. For the `main` agent group:

```json
{
  "provider": "opencode",
  "env": {
    "OPENCODE_PROVIDER": "ollama",
    "OPENCODE_MODEL": "ollama/gemma4:31b-jorgenclaw",
    "OPENCODE_SMALL_MODEL": "ollama/gemma4:31b-jorgenclaw",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:11434/v1",
    "NO_PROXY": "127.0.0.1,localhost",
    "no_proxy": "127.0.0.1,localhost"
  },
  …rest unchanged…
}
```

Reasoning:
- `provider: opencode` switches NanoClaw's per-agent runtime from the Claude Agent SDK to the OpenCode CLI provider.
- `OPENCODE_MODEL` and `OPENCODE_SMALL_MODEL` both point at your Ollama-baked model — OpenCode uses "small" for compaction/summarization passes; you want the same model so behavior is consistent.
- `ANTHROPIC_BASE_URL` overrides the SDK's outbound URL to localhost — Ollama's `/v1` endpoint speaks the OpenAI-compatible API that OpenCode expects.
- `NO_PROXY` ensures your host's OneCLI proxy (if you use the credential vault) doesn't intercept the local-loopback Ollama call.

Snapshot before editing:

```bash
cp ~/NanoClaw/groups/main/container.json ~/NanoClaw/groups/main/container.json.claude
```

Apply the edit, then:

```bash
docker kill $(docker ps --filter name=nanoclaw-v2-main -q)
```

The next inbound message respawns the container under OpenCode + Ollama.

---

## Step 3: Update CLAUDE.local.md with small-model guardrails

Small models read system prompts more literally and rely on explicit affordances that Claude infers. Add a section to `groups/main/CLAUDE.local.md` that:

1. **Tells the model exactly which tools to use for common tasks.** Pretrained Claude infers from context; small models need a lookup table.
2. **Explicitly identifies the binaries and paths** mounted in the container.
3. **Names the failure modes** (signer down, invoice expired, file not found) so the model knows what error categories to pattern-match.
4. **Gives a "what to do if a tool fails twice" rule** — small models will doom-loop without an explicit stop rule.

Reference excerpt for the tool-use guardrails:

```markdown
## Tool-use rules (READ before calling external tools)

You're running on a local Gemma model. Local models don't infer tool-calling
conventions as well as Claude — follow these explicit rules.

### Web/page lookups

Prefer in this order:
1. **MCP tool `weather(city)`** for weather. Don't use agent-browser.
2. **MCP tool `web_fetch(url)`** for any single page where you need content.
3. **`curl -s <url>`** for plain-text endpoints.
4. **`agent-browser open <url>`** ONLY when you need to interact (click/type).

### When a tool fails

Stop after **two failures** of the same approach. Tell the user what's broken
instead of looping. Doom-loop detection is now active in OpenCode and will cut
you off after a few retries — denying gracefully and explaining is better than
getting cut off mid-attempt.
```

Plus per-feature sections (Lightning, Clawstr, Proton Bridge, etc.) listing the actual command syntax with examples. The full version of this group's CLAUDE.local.md is checked into NanoClaw's `groups/main/CLAUDE.local.md` and is the reference; copy it as a starting point.

---

## Step 4: Container-side MCP tools to short-circuit small-model failure modes

Small models doom-loop on multi-step browser interactions (open → snapshot → click → snapshot → ...). Three single-call MCP tools cover the common cases without that latency:

- `container/agent-runner/src/mcp-tools/weather.ts` — wraps `wttr.in` JSON
- `container/agent-runner/src/mcp-tools/web-fetch.ts` — single-call URL → extracted text
- `container/agent-runner/src/mcp-tools/web-search.ts` — DuckDuckGo HTML scrape

Plus two tools added specifically for small-model failure modes:

- `container/agent-runner/src/mcp-tools/report-failure.ts` — explicit "I cannot complete this turn" tool. Requires an `attempted` arg naming the actual tool the model called and the literal error observed. Prevents preemptive failure reports based on stale context.
- `container/agent-runner/src/mcp-tools/transcription.ts` — wraps local-whisper for any audio attachment the model wants to re-transcribe.

Each tool registers via the standard pattern:

```typescript
// at module scope
import { registerTools } from './server.js';
registerTools([{ tool: { name: '…', description: '…', inputSchema: {…} }, handler: async (args) => {…} }]);

// then in mcp-tools/index.ts add: import './your-tool.js';
```

---

## Step 5: Host-side fixes in `src/providers/opencode.ts`

The host-side OpenCode container-config registration handles a few small-model-specific gotchas:

1. **Auto-wipe on model change.** OpenCode persists the model name into its session DB. If you tweak params and `ollama create` a new build under the same name, OpenCode resumes against the new weights and Ollama silently hangs — manifesting as repeating `OpenCode event timeout (300000ms) — clearing session` log lines and sustained Ollama runner CPU with no useful output.

   Fix: store a model **fingerprint** in `.last-model` instead of just the name. Fingerprint is `<model-name>|<sha256(ollama show --modelfile <name>)[:16]>`. Any change to weights, params, template, or FROM blob hash flips the fingerprint and triggers the existing wipe path.

2. **Doom-loop denial.** `permission.updated` event handler denies any new auto-approve permission for `doom_loop` style operations.

3. **Per-session XDG mount.** OpenCode stores its session DB at `XDG_DATA_HOME/opencode/`; the host pins this to a per-session directory under `data/v2-sessions/<sess>/opencode-xdg/` so each agent instance is isolated.

The full implementation is in `src/providers/opencode.ts` — primary entry points are `maybeWipeOnModelChange()` and `computeModelFingerprint()`.

---

## Step 6: Verify it works

After steps 1–5 + a `pnpm run build` and `systemctl --user restart nanoclaw`, send a test message via your wired channel (Signal, Discord, etc.). Verify in `logs/nanoclaw.log`:

```
INFO  OpenCode model changed — wiping session state  (first run only)
INFO  Spawning container  containerName=nanoclaw-v2-main-…
```

And in `docker logs <container>`:

```
[poll-loop] Session: ses_…
[poll-loop] Result: <message to="scott">…</message>
```

If you see `Result: <internal>…</internal>` with no `<message to=…>`, the host-side fallback in `poll-loop.ts:431` should surface a `⚠️ Internal-only output …` message back to the user. If you see those warnings frequently, check the **[Open issues](#open-issues--known-limitations)** section.

---

## Open issues & known limitations

Documented as of 2026-05-04:

1. **Silent-turn variants.** Even with the host-side fallback and the `report_failure` tool, gemma sometimes:
   - Generates only the literal hiragana character `を` ("wo") or `<|"|>` token-confusion artifacts when in a degraded inference state.
   - Produces zero output (no `<internal>`, no `<message>`, just an empty stream end). The host-side fallback only fires when output is non-empty.

   Both modes have a workaround: stop the container (`docker kill`), clear the OpenCode session ID (`DELETE FROM session_state WHERE key = 'sdk_session_id'` in `outbound.db`), wipe `opencode-xdg/opencode/`, restart NanoClaw, send a fresh message. The auto-wipe fingerprint check makes this less common across genuine model changes but doesn't help when the same Modelfile produces degraded inference within a single session.

2. **OpenCode cwd is `/workspace/group`, not `/workspace/agent`.** Gemma's `glob **/file` returns empty for files in `/workspace/agent/memory/` because they're outside cwd. Worked around with absolute-path documentation in CLAUDE.local.md ("Where to find your files"). Real fix is in the host-side container-runner where OpenCode is spawned — not yet implemented.

3. **Concurrent-poll race causes duplicate transcription.** Cosmetic — gemma occasionally sees the same audio attachment twice in one turn and replies twice. Documented in `container/agent-runner/src/poll-loop.ts:258` (the concurrent poller) and a memory note (`project_dup_transcribe_followup.md`). Fix sketch: maintain an in-memory `inFlightIds` set in the container; not yet implemented.

4. **Model-state corruption mid-turn.** A long inference (>5 min) sometimes produces garbage tokens partway through, polluting the rest of the turn. Workarounds tried: lowering temperature (helps slightly), bumping `repeat_last_n` (helps slightly). Not solved. Tier 3/4 work would address this with finer sampling control or a fine-tune for tool-use compliance — out of scope for "good enough for daily use."

---

## Switching between Claude and gemma

The whole tuning is reversible with one file swap and a container kill in either direction. Snapshot both forms once and you can A/B freely.

### Snapshot both configs

```bash
# Snapshot the gemma config (after tuning)
cp ~/NanoClaw/groups/main/container.json ~/NanoClaw/groups/main/container.json.gemma

# Snapshot the Claude config — make this version of container.json by editing
# back to provider:claude with no OPENCODE_*/ANTHROPIC_BASE_URL env, then:
cp ~/NanoClaw/groups/main/container.json ~/NanoClaw/groups/main/container.json.claude
```

### Switch to Claude

```bash
cp ~/NanoClaw/groups/main/container.json.claude ~/NanoClaw/groups/main/container.json
docker kill $(docker ps --filter name=nanoclaw-v2-main -q) 2>/dev/null
```

### Switch back to gemma

```bash
cp ~/NanoClaw/groups/main/container.json.gemma ~/NanoClaw/groups/main/container.json
docker kill $(docker ps --filter name=nanoclaw-v2-main -q) 2>/dev/null
```

### What stays inert under Claude

All of the gemma-era changes from this guide are no-ops when the provider is `claude`:

- `src/providers/opencode.ts` — only fires when `provider: opencode`
- The doom-loop denial in `container/agent-runner/src/providers/opencode.ts` — same
- The new MCP tools (weather, web_fetch, web_search, report_failure) — Claude can use them too, just rarely needs to
- The Modelfile in Ollama — Ollama keeps it, doesn't run unless something asks
- The Tool-use rules section in CLAUDE.local.md — Claude reads it; the rules are conservative enough to not hurt Claude's behavior, but you might prefer to comment them out for cleaner Claude turns

The CLAUDE.local.md "Tool-use rules" section explicitly says "you are running on a local Gemma model" — Claude will read this and adjust slightly. If you A/B between providers regularly, consider gating that section behind a `<!-- gemma-only -->` HTML comment that you toggle, or splitting CLAUDE.local.md into two and symlinking based on provider. For occasional revert it's not worth the complexity.

### Reclaim disk if going Claude-only

```bash
ollama rm gemma4:31b-jorgenclaw gemma4:31b-it-q8_0
# (also remove any other gemma variants you pulled)
```

The first removal frees ~57 GB; the second frees the base layer that the custom Modelfile pulls from.

---

## What's NOT in this guide

- **OneCLI credential vault setup** — orthogonal. Works the same under Claude or local-gemma. See `docs/onecli.md`.
- **Per-channel adapter config** (Signal, Discord, etc.) — also orthogonal.
- **Re-flashing a T-Watch S3** for the watch channel — see `docs/watch-firmware.md` (TODO when published).

---

## Changelog

- **2026-05-04** — Initial version covering EVO-X2 deployment. Captures the param tuning (`num_predict`, `repeat_last_n`), the auto-wipe fingerprint fix, the `report_failure` tightening, the container.json `PROTON_BRIDGE_IMAP_HOST` 172.17.0.1→127.0.0.1 fix (`--network host` related), the Pass `XDG_DATA_HOME` override + RW mount, and the NWC CLI dependency install. Open issues noted.

---

*Maintained by Scott Jorgensen + collaborators. License: same as NanoClaw (see `LICENSE`).*
