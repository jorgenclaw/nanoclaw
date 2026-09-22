import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import { createServer } from 'net';
import path from 'path';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { CONTEXT_OVERFLOW_USER_MESSAGE, isContextOverflowError } from './opencode-overflow.js';
import { TurnResultTracker } from './opencode-turn-result.js';

/**
 * Detect `[Image: <absolute-path>]` markers in user-message text and convert
 * them into opencode FilePartInput attachments alongside the text part.
 *
 * Why: signal.ts (and other channels) inline image attachments as a literal
 * `[Image: /workspace/attachments/<id>]` line in message text. Without this
 * conversion, opencode forwards the text marker verbatim to the model and
 * the model — even on a vision-capable provider — receives no image bytes
 * and falls back to "I can't see images." See docs/quad-inbox debugging
 * 2026-05-09 for the full forensic trail.
 *
 * Implementation: pure regex over the prompt text, read the referenced files
 * from disk, base64-encode, and return them as FilePartInput parts. The
 * original marker stays in the text so the model has caption context. We
 * silently skip markers whose path is unreadable (file gone, permission
 * denied) — a missing image isn't worth aborting the whole turn over;
 * "I tried to look at the attachment but the file is gone" is a perfectly
 * sensible reply for the model to construct from text alone.
 *
 * Sniffer: only paths under known mounts (`/workspace/attachments` for
 * Signal, `/run/whitenoise/media_cache` for White Noise) are accepted, to
 * avoid prompt-injection where external content names a host file.
 */
const IMAGE_MARKER_RE = /\[Image:\s+(\/[^\]\s]+)\]/g;
const ALLOWED_IMAGE_ROOTS = ['/workspace/attachments/', '/run/whitenoise/media_cache/'];
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

interface FilePartInput {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}

function extractImageParts(text: string): FilePartInput[] {
  const parts: FilePartInput[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(IMAGE_MARKER_RE)) {
    const filePath = match[1];
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!ALLOWED_IMAGE_ROOTS.some((root) => filePath.startsWith(root))) {
      log(`Skipping image marker outside allowed roots: ${filePath}`);
      continue;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = IMAGE_MIME_BY_EXT[ext];
    if (!mime) {
      log(`Skipping image marker with unknown extension: ${filePath}`);
      continue;
    }
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch (err) {
      log(`Skipping unreadable image: ${filePath} (${(err as Error).message})`);
      continue;
    }
    parts.push({
      type: 'file',
      mime,
      filename: path.basename(filePath),
      url: `data:${mime};base64,${buf.toString('base64')}`,
    });
    log(`Attached image: ${filePath} (${buf.length} bytes, ${mime})`);
  }
  return parts;
}

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function pickFreePort(hostname = '127.0.0.1'): Promise<number> {
  // Containers in the same agent group run with --network=host, so they share
  // the host loopback. A hardcoded port collides as soon as two sessions in
  // the same group spawn concurrently. Let the kernel hand us an ephemeral
  // port; small TOCTOU window between close() and opencode bind, but
  // acceptable in practice and recoverable via the existing exit-on-error path.
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, hostname, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close((err) => (err ? reject(err) : resolve(port)));
      } else {
        srv.close(() => reject(new Error('pickFreePort: no address from listener')));
      }
    });
  });
}

async function spawnOpencodeServer(
  config: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ url: string; proc: ChildProcess }> {
  const hostname = '127.0.0.1';
  const port = await pickFreePort(hostname);
  return new Promise((resolve, reject) => {
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [
                      mid,
                      {
                        id: mid,
                        name: mid,
                        tool_call: true,
                        attachment: true,
                        // Flips opencode's capabilities.input.image so unsupportedParts()
                        // stops stripping image content. Verified 2026-05-11 against
                        // gemma4:26b via @ai-sdk/openai-compatible → Ollama. See
                        // memory/project_vision_sidecar_2026_05_10.md.
                        modalities: { input: ['text', 'image'], output: ['text'] },
                      },
                    ]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/app/opencode-notes.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  // QUAD_INBOX_WRITER.md is a plain top-level file, not a fragment or
  // CLAUDE.local.md itself, so it's invisible to the instructions list above
  // unless a group happens to have one. Under Claude, the model reliably
  // follows CLAUDE.local.md's "read that file before filing a task"
  // pointer; smaller local models are much less consistent about chasing an
  // indirect file reference mid-conversation, so the full writer spec
  // silently never enters context and tasks come out malformed or never get
  // written at all. Load it directly, same as CLAUDE.local.md, whenever the
  // group actually has one — this is a no-op for groups (e.g. non-Jorgenclaw
  // agent groups) that don't ship this file.
  if (fs.existsSync('/workspace/agent/QUAD_INBOX_WRITER.md')) {
    instructions.push('/workspace/agent/QUAD_INBOX_WRITER.md');
  }

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    // `client.event.subscribe()` returns a lazy generator — the actual GET
    // /event SSE connection doesn't open until the first `stream.next()`
    // call. Without priming it here, the first real caller only connects
    // *after* issuing `promptAsync`, so a prompt that fails synchronously
    // fast (e.g. NotFoundError on a stale/invalid session) publishes its
    // `session.error` bus event before anyone is listening — the event is
    // lost forever and the query hangs until the 5-minute idle timeout.
    // Priming consumes the harmless first `server.connected` event (already
    // filtered by the normal consumption loop below), guaranteeing the
    // connection is live before any prompt is ever sent.
    await stream.next();
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  private memoryHook: MemorySessionHookRegistration | undefined;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * OpenCode has no native session-start hook mechanism like Claude Code's
   * settings.json (which Claude Code itself invokes at startup/clear/compact).
   * Store the registration and inject memory as an extra text part ourselves,
   * once per NEW session (see query() below) — functionally equivalent for
   * the 'startup' case; 'clear'/'compact' aren't separately observable here.
   */
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memoryHook = hook;
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    const systemInstructions = input.systemContext?.instructions;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;
        let isNewSession = false;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
          isNewSession = true;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const imageParts = extractImageParts(text);
        // Memory context: Claude Code gets this via a native SessionStart hook (see
        // registerMemorySessionHook above); OpenCode has no equivalent, so inject it
        // as a leading text part on the first prompt of each new session instead.
        const memoryText = isNewSession && self.memoryHook ? memoryContextForSessionStart('startup') : undefined;
        const parts: Array<{ type: 'text'; text: string } | FilePartInput> = [
          ...(memoryText ? [{ type: 'text' as const, text: memoryText }] : []),
          { type: 'text', text },
          ...imageParts,
        ];
        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        // Collects the turn's messages and picks the reply text, including
        // what to keep when OpenCode compacts mid-turn (see opencode-turn-result.ts).
        const turnResult = new TurnResultTracker();
        // Context overflow: OpenCode reports the error, then compacts the
        // session and finishes the turn itself. Track it so we wait for that
        // instead of failing the turn (see opencode-overflow.ts).
        let overflowSeen = false;
        let compacted = false;

        // A wedged OpenCode/model backend can leave `stream.next()` pending
        // forever — no more events ever arrive, but the awaited promise
        // never settles either. Checking elapsed time on an interval doesn't
        // help in that case: there's no next loop iteration to notice the
        // check until stream.next() resolves, so the timeout is never
        // actually observed and the container just burns inference time
        // until the host's absolute-ceiling SIGKILL (which then respawns
        // and resumes the same wedged session, repeating forever). Race the
        // read itself against the timeout so idleness is caught even when
        // the stream truly never delivers another event.
        turn: while (true) {
          if (aborted) return;

          const nextEvent = stream.next();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const idle = new Promise<'idle'>((resolve) => {
            timeoutHandle = setTimeout(() => resolve('idle'), IDLE_TIMEOUT_MS);
          });

          const raced = await Promise.race([nextEvent, idle]);
          clearTimeout(timeoutHandle);

          if (raced === 'idle') {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            self.activeSessionId = undefined;
            destroySharedRuntime();
            // The abandoned read settles once the process above is killed
            // (resolve or reject) — nothing awaits it, so swallow any
            // eventual rejection to avoid an unhandled promise rejection.
            nextEvent.catch(() => {});
            throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
          }

          const { value: ev, done } = raced;
          if (done) {
            throw new Error('OpenCode SSE stream ended unexpectedly');
          }

          if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

          yield { type: 'activity' };

          switch (ev.type) {
            case 'message.updated': {
              turnResult.onMessageUpdated(
                ev.properties.info as { id?: string; role?: string; summary?: unknown; finish?: string } | undefined,
              );
              break;
            }
            case 'message.part.updated': {
              turnResult.onPartUpdated(
                ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined,
              );
              break;
            }
            case 'permission.updated': {
              // OpenCode emits permission events for each tool call. We
              // auto-reply 'always' for normal permissions (no human at the
              // keyboard to answer), but DENY 'doom_loop' permissions —
              // OpenCode sets this when it detects the model retrying the
              // same tool with no progress. Letting the loop continue burns
              // tokens/inference time and never recovers; denying forces the
              // model to stop and summarize what it knows.
              const perm = ev.properties as {
                id?: string;
                sessionID?: string;
                permission?: string;
                type?: string;
              };
              if (perm.sessionID === sessionId && perm.id) {
                const permType = perm.permission ?? perm.type;
                const isDoomLoop = permType === 'doom_loop';
                const response = isDoomLoop ? ('reject' as const) : ('always' as const);
                if (isDoomLoop) {
                  log(`Doom-loop detected (permission ${perm.id}) — denying to break the loop`);
                }
                try {
                  await client.postSessionIdPermissionsPermissionId({
                    path: { id: sessionId, permissionID: perm.id },
                    body: { response },
                  });
                } catch (err) {
                  log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              break;
            }
            case 'session.status': {
              const props = ev.properties as {
                sessionID?: string;
                status?: { type?: string; attempt?: number; message?: string };
              };
              if (props.sessionID !== sessionId) break;
              const st = props.status;
              if (
                st?.type === 'retry' &&
                typeof st.attempt === 'number' &&
                st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                st.message
              ) {
                self.activeSessionId = undefined;
                throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
              }
              break;
            }
            case 'session.error': {
              const props = ev.properties as { sessionID?: string; error?: unknown };
              if (props.sessionID === sessionId || props.sessionID === undefined) {
                if (isContextOverflowError(props.error)) {
                  log(`Context overflow: ${sessionErrorMessage(props)}`);
                  if (!overflowSeen) {
                    // First overflow this turn: OpenCode compacts and carries
                    // on by itself, so keep reading events until it goes idle.
                    overflowSeen = true;
                    break;
                  }
                  // Overflowed again after compacting — give up.
                  self.activeSessionId = undefined;
                  throw new Error(CONTEXT_OVERFLOW_USER_MESSAGE);
                }
                self.activeSessionId = undefined;
                throw new Error(sessionErrorMessage(props));
              }
              break;
            }
            case 'session.compacted': {
              const sid = (ev.properties as { sessionID?: string }).sessionID;
              if (sid === sessionId) compacted = true;
              break;
            }
            case 'session.idle': {
              const sid = (ev.properties as { sessionID?: string }).sessionID;
              if (sid === sessionId) {
                if (overflowSeen && !compacted) {
                  // Idle after an overflow with no compaction: nothing
                  // recovered the turn, and an empty result would look like
                  // silence. Tell the user instead.
                  self.activeSessionId = undefined;
                  throw new Error(CONTEXT_OVERFLOW_USER_MESSAGE);
                }
                break turn;
              }
              break;
            }
            default:
              break;
          }
        }

        yield { type: 'result', text: turnResult.resultText() || null };
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
