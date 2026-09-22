/**
 * Picks the reply text for one OpenCode turn.
 *
 * A turn is one `promptAsync` call. OpenCode may create several assistant
 * messages in it (one per tool-call step), and the reply is normally the text
 * of the last one that has any.
 *
 * Compaction breaks that. When a finished reply pushes the session over its
 * window (`limit.context` minus the output reserve), OpenCode compacts the
 * session and then injects a synthetic user message ("Continue if you have next
 * steps, ..."). The model answers that with a recap ("here's where we stand:
 * Completed ... No pending follow-ups"), which is the *last* assistant text of
 * the turn, so "last text wins" sends the recap and drops the reply the user
 * actually asked for. Seen 2026-09-21: a 3.7k-char answer was lost and the user
 * was told the work was done.
 *
 * Rule: if the assistant had already finished a reply with text
 * (`finish: "stop"`) before compaction started, that reply is the answer and
 * whatever the model says afterwards is discarded. Otherwise compaction
 * interrupted unfinished work (an overflow error, or a tool-call step), the
 * post-compaction message is the real continuation, and "last text wins" still
 * applies.
 */

interface MessageInfo {
  id?: string;
  role?: string;
  summary?: unknown;
  finish?: string;
}

interface PartInfo {
  type?: string;
  messageID?: string;
  text?: string;
}

export class TurnResultTracker {
  private readonly roleByMessageId = new Map<string, string>();
  private readonly textByMessageId = new Map<string, string>();
  private readonly finishByMessageId = new Map<string, string | undefined>();
  // Compaction summaries are assistant messages full of text that must never
  // be mistaken for the turn's reply.
  private readonly summaryMessageIds = new Set<string>();
  // Messages that existed when compaction started, once it has.
  private messagesBeforeCompaction: Set<string> | undefined;

  /** Feed the `info` of a `message.updated` event. */
  onMessageUpdated(info: MessageInfo | undefined): void {
    if (!info?.id || !info.role) return;
    this.roleByMessageId.set(info.id, info.role);
    if (info.role !== 'assistant') return;
    this.finishByMessageId.set(info.id, info.finish);
    if (info.summary === true) {
      this.summaryMessageIds.add(info.id);
      this.markCompactionStarted();
    }
  }

  /** Feed the `part` of a `message.part.updated` event. */
  onPartUpdated(part: PartInfo | undefined): void {
    if (part?.type === 'compaction') {
      this.markCompactionStarted();
    } else if (part?.type === 'text' && part.messageID && part.text) {
      this.textByMessageId.set(part.messageID, part.text);
    }
  }

  /** The turn's reply text, or '' when the assistant produced none. */
  resultText(): string {
    const replyIds = [...this.roleByMessageId]
      .filter(([id, role]) => role === 'assistant' && !this.summaryMessageIds.has(id))
      .map(([id]) => id);

    const before = this.messagesBeforeCompaction;
    if (before) {
      const finished = replyIds.filter(
        (id) => before.has(id) && this.finishByMessageId.get(id) === 'stop' && this.textByMessageId.has(id),
      );
      if (finished.length > 0) return this.textByMessageId.get(finished[finished.length - 1]) as string;
    }

    let text = '';
    for (const id of replyIds) text = this.textByMessageId.get(id) ?? text;
    return text;
  }

  // The compaction marker (a `compaction` part) and the summary message both
  // appear before any post-compaction reply, so either one fixes the boundary.
  private markCompactionStarted(): void {
    if (!this.messagesBeforeCompaction) this.messagesBeforeCompaction = new Set(this.roleByMessageId.keys());
  }
}
