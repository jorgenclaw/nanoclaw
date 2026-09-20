/**
 * Text-answerable question cards for Matrix.
 *
 * NanoClaw asks the owner for approvals (create_agent, package installs, new
 * channels, …) with Chat SDK "cards" whose buttons the user clicks. Element X
 * cannot render those buttons — the Matrix adapter flattens a card to plain
 * text — so on this install no approval was ever answerable and every one
 * sat pending. This file makes cards answerable by replying with a number.
 *
 *   Outbound: cardToAnswerableText() turns a question card into
 *             "title / question / Reply with a number: 1. Approve …" and the
 *             question id is stamped on the Matrix event itself
 *             (QUESTION_KEY), so the link survives a restart and needs no
 *             extra database table.
 *   Inbound:  matchAnswer() maps a short reply ("1", "approve") onto the card's
 *             options and findPendingCard() finds the newest card that is still
 *             pending. The host's normal response path then resolves it; the
 *             approvals code still checks the sender is an authorized approver,
 *             so an answer typed by anyone else is ignored.
 *
 * Pure functions only — the client/timeline glue lives in matrix.ts.
 */

/** Custom content key stamped on a question card's Matrix event. */
export const QUESTION_KEY = 'ai.jorgenclaw.question';

/** Button ids built by the bridge: `ncq:<questionId>:<optionIndex>`. */
const BUTTON_ID = /^ncq:([^:]+):(\d+)$/;

export interface AnswerableCard {
  text: string;
  questionId: string;
}

interface CardNode {
  type?: unknown;
  title?: unknown;
  content?: unknown;
  id?: unknown;
  label?: unknown;
  children?: unknown;
}

function collect(node: unknown, texts: string[], buttons: Array<{ questionId: string; index: number; label: string }>) {
  if (!node || typeof node !== 'object') return;
  const n = node as CardNode;
  if (n.type === 'text' && typeof n.content === 'string') texts.push(n.content);
  if (n.type === 'button' && typeof n.id === 'string') {
    const m = BUTTON_ID.exec(n.id);
    if (m) buttons.push({ questionId: m[1], index: Number(m[2]), label: String(n.label ?? '') });
  }
  if (Array.isArray(n.children)) for (const child of n.children) collect(child, texts, buttons);
}

/**
 * If `message` is a question card (the bridge's `ask_question`), return the
 * numbered-text rendering and its question id. Anything else (plain text, a
 * display card with no answer buttons) returns null and is posted as before.
 */
export function cardToAnswerableText(message: unknown): AnswerableCard | null {
  if (!message || typeof message !== 'object') return null;
  const wrapped = (message as { card?: unknown }).card;
  const card = (wrapped && typeof wrapped === 'object' ? wrapped : message) as CardNode;
  if (card.type !== 'card') return null;

  const texts: string[] = [];
  const buttons: Array<{ questionId: string; index: number; label: string }> = [];
  collect(card, texts, buttons);
  if (buttons.length === 0) return null;

  buttons.sort((a, b) => a.index - b.index);
  const title = typeof card.title === 'string' ? card.title : '';
  const lines = [
    ...(title ? [title, ''] : []),
    ...(texts.length ? [texts.join('\n\n'), ''] : []),
    'Reply with a number:',
    ...buttons.map((b, i) => `${i + 1}. ${b.label}`),
  ];
  return { text: lines.join('\n'), questionId: buttons[0].questionId };
}

const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s.…!)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Map a short reply onto a card option: a number (1-based) or the option's
 * label. Anything else — including "approve please" — is NOT an answer, so an
 * ordinary chat message is never swallowed.
 */
export function matchAnswer<T extends { label: string }>(text: string, options: T[]): T | null {
  const t = normalize(text);
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= options.length ? options[n - 1] : null;
  }
  return options.find((o) => normalize(o.label) === t) ?? null;
}

/** The slice of a Matrix event this needs (matrix-js-sdk's MatrixEvent satisfies it). */
export interface CardEventLike {
  getSender(): string | undefined;
  getContent(): Record<string, unknown>;
}

/**
 * The newest question card the bot posted that is still pending. `eventsNewestFirst`
 * is a room timeline, newest first; `isPending` says whether the question id is
 * still awaiting an answer (its database row still exists).
 */
export function findPendingCard(
  eventsNewestFirst: CardEventLike[],
  botId: string,
  isPending: (questionId: string) => boolean,
): string | null {
  for (const ev of eventsNewestFirst) {
    if (ev.getSender() !== botId) continue;
    const marker = ev.getContent()?.[QUESTION_KEY] as { id?: unknown } | undefined;
    if (typeof marker?.id === 'string' && isPending(marker.id)) return marker.id;
  }
  return null;
}
