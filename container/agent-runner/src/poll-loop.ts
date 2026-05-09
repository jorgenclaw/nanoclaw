import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut, getOutboundCount } from './db/messages-out.js';
import { touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { getStoredSessionId, setStoredSessionId, clearStoredSessionId } from './db/session-state.js';
import { getSessionRouting } from './db/session-routing.js';
import { formatMessages, extractRouting, categorizeMessage, isClearCommand, stripInternalTags, type RoutingContext } from './formatter.js';
import { setActiveRouting } from './active-routing.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Recognize when a model has emitted raw tool-call syntax instead of a real
 * response. Smaller local models (e.g. gemma4:26b) sometimes hallucinate
 * non-existent tools and then fall back to writing the literal call syntax
 * as plain text — `call:nanoweb_search{query:...}<tool_call|>` etc. Sending
 * that raw to the user is worse than nothing; it looks like the agent broke.
 *
 * The check is deliberately conservative: we only suppress if the entire
 * cleaned text is dominated by these markers, so a real reply that happens
 * to mention a tool name in passing still gets through.
 */
function looksLikeHallucinatedToolCall(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Hard markers the model emits when its tool-call format is broken.
  const markers = [/<\|?tool_call\|?>/i, /\bcall:[a-z][a-z0-9_]*\s*\{/i, /<\|"\|>/];
  const hasMarker = markers.some((re) => re.test(t));
  if (!hasMarker) return false;
  // Also require the response to be short — long responses with one
  // accidental marker probably contain real content too.
  return t.length < 400;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.).
  let continuation: string | undefined = getStoredSessionId();

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  while (true) {
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages().filter((m) => m.kind !== 'system');
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);
    setActiveRouting(routing);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearStoredSessionId();
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Auto-transcribe audio attachments before formatting
    const { autoTranscribeMessages } = await import('./auto-transcribe.js');
    keep = await autoTranscribeMessages(keep);

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    try {
      const result = await processQuery(query, routing, processingIds);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setStoredSessionId(continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearStoredSessionId();
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;

  // Snapshot the outbound count so we can detect a silent turn — the model
  // ended without writing any user-visible reply (no <message> block, no
  // send_message MCP call, no scratchpad fallback). When that happens we
  // write a generic "I couldn't reply" message so the user isn't left
  // wondering whether the agent crashed.
  const outboundCountAtStart = getOutboundCount();

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open is
  // strictly cheaper than close+reopen (no cold prompt cache, no reconnect).
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  const pollHandle = setInterval(async () => {
    if (done) return;

    // Skip system messages (MCP tool responses) and /clear (needs fresh query).
    // Thread routing is the router's concern — if a message landed in this
    // session, the agent should see it. Per-thread sessions already isolate
    // threads into separate containers; shared sessions intentionally merge
    // everything. Filtering on thread_id here caused deadlocks when the
    // initial batch and follow-ups had mismatched thread_ids (e.g. a
    // host-generated welcome trigger with null thread vs a Discord DM reply).
    const newMessages = getPendingMessages().filter((m) => {
      if (m.kind === 'system') return false;
      if ((m.kind === 'chat' || m.kind === 'chat-sdk') && isClearCommand(m)) return false;
      return true;
    });
    if (newMessages.length > 0) {
      const newIds = newMessages.map((m) => m.id);
      markProcessing(newIds);

      const { autoTranscribeMessages } = await import('./auto-transcribe.js');
      const preprocessed = await autoTranscribeMessages(newMessages);
      const prompt = formatMessages(preprocessed);
      log(`Pushing ${newMessages.length} follow-up message(s) into active query`);
      query.push(prompt);

      markCompleted(newIds);
    }
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setStoredSessionId(event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        if (event.text) {
          dispatchResultText(event.text, routing);
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
  }

  // Silent-turn fallback: the model produced no <message> block, no
  // send_message MCP call, and no scratchpad fallback delivery. This is
  // a contract violation per CLAUDE.md ("Never end a turn silently"), but
  // some models — especially smaller local ones — hallucinate tool calls
  // or emit garbled output that doesn't parse, and the user is left with
  // nothing. Write a generic message so they at least know something
  // happened.
  if (getOutboundCount() === outboundCountAtStart) {
    const sessionRouting = getSessionRouting();
    if (sessionRouting.channel_type && sessionRouting.platform_id) {
      log('Silent turn detected — writing fallback message to user');
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: sessionRouting.platform_id,
        channel_type: sessionRouting.channel_type,
        thread_id: sessionRouting.thread_id,
        content: JSON.stringify({
          text: "Sorry — I had trouble producing a response that turn. Could you try again, maybe rephrasing?",
        }),
      });
    } else {
      log('Silent turn detected but no session routing — fallback skipped');
    }
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(`Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`);
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

/**
 * Parse the agent's final text for <message to="name">...</message> blocks
 * and dispatch each one to its resolved destination. Text outside of blocks
 * (including <internal>...</internal>) is normally scratchpad — logged but
 * not sent.
 *
 * Single-destination shortcut: if the agent has exactly one configured
 * destination AND the output contains zero <message> blocks, the entire
 * cleaned text (with <internal> tags stripped) is sent to that destination.
 * This preserves the simple case of one user on one channel — the agent
 * doesn't need to know about wrapping syntax at all.
 */
function dispatchResultText(rawText: string, routing: RoutingContext): void {
  // Suppress hallucinated tool-call text BEFORE any downstream dispatch path
  // sees it — both the single-destination shortcut and the internal-only
  // fallback would otherwise forward the garbage to the user.
  let text = rawText;
  if (looksLikeHallucinatedToolCall(rawText)) {
    log(`Suppressed hallucinated tool-call output (${rawText.length} chars) — silent-turn fallback will fire`);
    text = '';
  }

  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;

  let match: RegExpExecArray | null;
  let sent = 0;
  let lastIndex = 0;
  const scratchpadParts: string[] = [];

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    const toName = match[1];
    const body = match[2].trim();
    lastIndex = MESSAGE_RE.lastIndex;

    const dest = findByName(toName);
    if (!dest) {
      log(`Unknown destination in <message to="${toName}">, dropping block`);
      scratchpadParts.push(`[dropped: unknown destination "${toName}"] ${body}`);
      continue;
    }
    sendToDestination(dest, body, routing);
    sent++;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  const scratchpad = stripInternalTags(scratchpadParts.join(''));

  // Single-destination shortcut: the agent wrote plain text — send to
  // the session's originating channel (from session_routing) if available,
  // otherwise fall back to the single destination.
  //
  // We prefer session_routing over the batch's routing context because
  // routing is captured from the FIRST message of the initial batch
  // (extractRouting in poll-loop). When follow-up messages get pushed
  // into an active query, the lead-row routing leaks into their replies —
  // e.g., a stale recurring task with a dead JID landing first causes
  // every subsequent watch tap or DM in the same turn to be addressed
  // back to the dead JID. session_routing is the canonical destination
  // committed by the host for this session and never drifts.
  if (sent === 0 && scratchpad) {
    const sessionRouting = getSessionRouting();
    if (sessionRouting.channel_type && sessionRouting.platform_id) {
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: sessionRouting.platform_id,
        channel_type: sessionRouting.channel_type,
        thread_id: sessionRouting.thread_id,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    if (routing.channelType && routing.platformId) {
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: scratchpad }),
      });
      return;
    }
    const all = getAllDestinations();
    if (all.length === 1) {
      sendToDestination(all[0], scratchpad, routing);
      return;
    }
  }

  if (scratchpad) {
    log(`[scratchpad] ${scratchpad.slice(0, 500)}${scratchpad.length > 500 ? '…' : ''}`);
  }

  if (sent === 0 && text.trim()) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
    // Fallback: surface a brief notice + the internal text (truncated) to the
    // session's originating channel so the user knows the turn silently
    // failed. Without this the user just sees nothing back. Common with
    // smaller models that stay inside <internal> when they hit an obstacle
    // and never switch into <message to="..."> mode.
    const sessionRouting = getSessionRouting();
    const dest =
      sessionRouting.channel_type && sessionRouting.platform_id
        ? {
            platformId: sessionRouting.platform_id,
            channelType: sessionRouting.channel_type,
            threadId: sessionRouting.thread_id,
          }
        : routing.channelType && routing.platformId
          ? {
              platformId: routing.platformId,
              channelType: routing.channelType,
              threadId: routing.threadId,
            }
          : null;
    if (dest) {
      const internal = text.trim();
      const preview = internal.length > 800 ? internal.slice(0, 800) + '…' : internal;
      const body = `⚠️ Internal-only output — I didn't produce a user-facing reply this turn. Internal text:\n\n${preview}`;
      writeMessageOut({
        id: generateId(),
        in_reply_to: routing.inReplyTo,
        kind: 'chat',
        platform_id: dest.platformId,
        channel_type: dest.channelType,
        thread_id: dest.threadId,
        content: JSON.stringify({ text: body }),
      });
    }
  }
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Inherit thread_id from the inbound routing context so replies land in the
  // same thread the conversation is in. For non-threaded adapters the router
  // strips thread_id at ingest, so this will already be null.
  writeMessageOut({
    id: generateId(),
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: body }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
