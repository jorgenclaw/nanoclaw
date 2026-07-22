# 08 — Agent-Runner Reliability & Provider Fixes

Four distinct fixes landed since `757471f4`, commits `e16753e`..`e7724a4`. Two are container-side (agent-runner, Bun), one is container-side (opencode vision), one is container-side (Claude binary path). None touch host-side `src/providers/index.ts` or `src/providers/opencode.ts` in ways relevant to this batch — those host-side files only picked up unrelated fingerprint-caching and per-session `opencode.json` config-writing changes (noted at the end).

## 1. Hallucination filter for raw tool-call text leaking to users

**Where:** CONTAINER-side, `container/agent-runner/src/poll-loop.ts`, function `looksLikeHallucinatedToolCall()` (top of file), called from `dispatchResultText()`.

**Problem:** Smaller/local models (gemma4:26b, qwen3.6:35b) sometimes fail to emit a structured tool call and instead write the tool-call syntax as literal text in their response. Two failure shapes observed in production:
- gemma style: `call:bash{command:<|"|>curl -s ...<|"|>}<tool_call|>`
- qwen XML style (multi-tool turns specifically):
  ```
  <read>
  <parameter=filePath>
  /workspace/agent/memory/ongoing.md
  </parameter>
  </function>
  </tool_call>
  ```
Forwarding this raw to the user reads as the agent having crashed. The qwen variant was added a commit later (`4e72b17e`) after the original gemma-only filter (`e16753e`) missed it in production.

**Fix:** `looksLikeHallucinatedToolCall(text)` checks the trimmed text against a marker list, requiring the whole text be short (< 600 chars — bumped from an initial 400, since the qwen XML form is more verbose):
```js
const markers = [
  /<\|?tool_call\|?>/i,                     // gemma <tool_call|> closer
  /<\/tool_call>/i,                         // qwen </tool_call> closer
  /<\/function>/i,                          // qwen/anthropic </function> closer
  /\bcall:[a-z][a-z0-9_]*\s*\{/i,           // gemma `call:bash{`
  /<\|"\|>/,                                // gemma <|"|> quote token
  /<parameter\s*=\s*[a-z_][a-z0-9_]*\s*>/i, // qwen-style <parameter=name>
  /<parameter\s+name\s*=\s*"[^"]+"\s*>/i,   // anthropic <parameter name="...">
];
```
Applied at the very top of `dispatchResultText(rawText, routing)`, before either downstream path (the `<message to="...">` regex dispatch and the "internal-only output" fallback) can see it — an earlier version applied the filter only after the `<message>` regex pass, so the internal-only fallback still leaked raw text via a second code path. Suppression sets local `text = ''`, letting the silent-turn fallback (fix #2) fire instead of forwarding garbage.

## 2. Silent-turn fallback moved into the result-event handler

**Where:** CONTAINER-side, `container/agent-runner/src/poll-loop.ts`, function `processQuery()` (result-event branch, ~line 339-375), plus new `getOutboundCount()` export in `container/agent-runner/src/db/messages-out.ts`.

**Problem:** The original design snapshotted `getOutboundCount()` once at the start of `processQuery` and once at the very end, writing a "try rephrasing" fallback message if nothing new was written to `messages_out`. This never fired in practice: `processQuery`'s `for await (const event of query.events)` loop doesn't return between turns — opencode keeps the session open across turns and only emits `result` on `session.idle`, waiting for the next `push()`. `processQuery` only returns when the whole `AgentQuery` is torn down (container shutdown). So the end-of-function count check was dead code — users saw nothing back on turns where the model hallucinated tool-call syntax on consecutive turns.

**Fix (`44bf2707`):** Move the count-comparison into the `result` event branch itself, snapshotting right before `dispatchResultText()` and comparing right after:
```js
} else if (event.type === 'result') {
  markCompleted(initialBatchIds);
  const beforeDispatch = getOutboundCount();
  if (event.text) {
    dispatchResultText(event.text, routing);
  }
  if (getOutboundCount() === beforeDispatch) {
    const sr = getSessionRouting();
    if (sr.channel_type && sr.platform_id) {
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: sr.platform_id,
        channel_type: sr.channel_type,
        thread_id: sr.thread_id,
        content: JSON.stringify({
          text: "Sorry — I had trouble producing a response that turn. Could you try again, maybe rephrasing?",
        }),
      });
    }
  }
}
```
The redundant top-of-function `outboundCountAtStart` snapshot was removed. `getOutboundCount()` is a trivial `SELECT COUNT(*) AS c FROM messages_out`. Now fires per-turn (not per-query-lifetime), catching both the empty-result case and the hallucination-suppressed case from fix #1.

## 3. Claude provider pointed at SDK-bundled native binary

**Where:** CONTAINER-side, `container/agent-runner/src/providers/claude.ts`, `sdkQuery(...)` call options, `pathToClaudeCodeExecutable` field.

**Problem:** A separate pnpm-11 PATH fix (`4a51169c`, see `10-scheduling-and-deps.md`) moved the global Claude Code install to `/pnpm/bin/claude`, but `claude.ts` was still hardcoded to the old `/pnpm/claude` path, and the new `/pnpm/bin/claude` wrapper resolves to `claude.exe` — broken on Linux. Surfaced live: three Claude-provider groups all replied with `"Claude Code native binary not found at /pnpm/claude"`.

**Fix (`e7724a46`):**
```diff
-        pathToClaudeCodeExecutable: '/pnpm/claude',
+        pathToClaudeCodeExecutable: '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
```
Points at the SDK-bundled native binary at a deterministic path, independent of pnpm's global-bin layout. No other logic around it changed. Note: the underlying broken `/pnpm/bin/claude` wrapper in the Dockerfile itself is a flagged follow-up, not fixed here.

## 4. Vision: sidecar removed, native `FilePartInput` image attachments used instead

**Where:** CONTAINER-side, `container/agent-runner/src/providers/opencode.ts`. Two sequential commits, net effect matters more than the intermediate state:
- `19ae0647` added an Ollama sidecar (`transcribeImagesInText`) that intercepted `[Image: <path>]` markers, called Ollama's native `/api/chat` (which supports the `images` field) directly, and spliced a text description back into the prompt before opencode saw it.
- `4a51169c` removed that sidecar entirely and replaced it with proper `FilePartInput` attachments plus per-model capability flags.

**Problem (original):** `opencode-ai` 1.4.17 with `@ai-sdk/openai-compatible` doesn't forward image attachments to Ollama — its OpenAI-compat adapter serializes user messages as `content:<string>` and silently drops `FilePartInput` parts, even when attached correctly. Confirmed via HTTP-proxy capture: zero `image_url`, zero `data:image` in outbound `/v1/chat/completions` bodies. The sidecar worked around this by doing vision inference out-of-band via Ollama's native API and embedding a text description, but added 5-30s of latency per image and lost pixel grounding.

**Root cause found, sidecar removed:** opencode strips image parts via its internal `unsupportedParts()` check, gated on a per-model `capabilities.input.image` flag that defaults false for unregistered models. The real fix is registering that capability, not routing around opencode. Two changes in `buildOpenCodeConfig()` (~line 209-223):
```js
models: Object.fromEntries(
  modelsToRegister.map((mid) => [
    mid,
    {
      id: mid,
      name: mid,
      tool_call: true,
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  ]),
),
```
And a new `extractImageParts(text)` function (top of file) that regex-matches `[Image: <absolute-path>]` markers (the same markers signal.ts/whitenoise inline into message text), reads the file, base64-encodes it, and returns `FilePartInput` objects (`{ type: 'file', mime, filename, url: 'data:<mime>;base64,<...>' }`) appended alongside the `{ type: 'text', text }` part in the `client.session.promptAsync(...)` call (~line 398-408). Paths are allow-listed to known mount roots only (`/workspace/attachments/`, `/run/whitenoise/media_cache/`) to prevent prompt-injection via an attacker-controlled path in message text — unreadable/unlisted paths are logged and silently skipped, never abort the turn.

**Reproduction note:** do not build the Ollama-sidecar workaround at all — implement only the final state (`modalities`/`attachment` config flags + `extractImageParts`/`FilePartInput`). Verified end-to-end against gemma4:26b via `@ai-sdk/openai-compatible` → Ollama.

## Not part of the four fixes, but touched by the same commit range

HOST-side `src/providers/opencode.ts` (Node, different file from #4) got an unrelated `computeModelFingerprint()` caching fix (memoize the Ollama digest per model name instead of re-probing, `ollama show --modelfile` timeout raised 5s→30s) and a new `writeOpencodeConfig()` that copies `~/.config/opencode/opencode.json` (or generates a minimal Ollama provider block) into the per-session XDG dir with `XDG_CONFIG_HOME=/opencode-xdg` set in the container env — without this, the container-side `modalities`/`attachment` flags in fix #4 never reach the actual opencode binary at runtime. HOST-side `src/providers/index.ts` also picked up a missing `import './opencode.js';` self-registration line — check on a clean checkout that this import is present if opencode is being used as a provider at all.
