import { Actions, Button, Card, CardText } from 'chat';
import { describe, expect, it } from 'vitest';

import { cardToAnswerableText, findPendingCard, matchAnswer, QUESTION_KEY } from './matrix-cards.js';

const OPTIONS = [{ label: 'Approve' }, { label: 'Reject' }, { label: 'Reject with reason…' }];

function approvalCard() {
  return Card({
    title: 'Create Matrix room: Bookkeeping',
    children: [
      CardText('Agent "Jorgenclaw" wants a room. Approve?'),
      Actions(OPTIONS.map((o, i) => Button({ id: `ncq:appr-1789-abc:${i}`, label: o.label, value: String(i) }))),
    ],
  });
}

describe('cardToAnswerableText', () => {
  it('turns a real Chat SDK question card into numbered text and finds its question id', () => {
    const out = cardToAnswerableText({ card: approvalCard(), fallbackText: 'ignored' });

    expect(out?.questionId).toBe('appr-1789-abc');
    expect(out?.text).toBe(
      [
        'Create Matrix room: Bookkeeping',
        '',
        'Agent "Jorgenclaw" wants a room. Approve?',
        '',
        'Reply with a number:',
        '1. Approve',
        '2. Reject',
        '3. Reject with reason…',
      ].join('\n'),
    );
  });

  it('accepts a bare card element too', () => {
    expect(cardToAnswerableText(approvalCard())?.questionId).toBe('appr-1789-abc');
  });

  it('keeps the option order even if buttons arrive shuffled', () => {
    const card = Card({
      title: 'T',
      children: [
        Actions([
          Button({ id: 'ncq:q1:1', label: 'Second', value: '1' }),
          Button({ id: 'ncq:q1:0', label: 'First', value: '0' }),
        ]),
      ],
    });
    expect(cardToAnswerableText(card)?.text).toContain('1. First\n2. Second');
  });

  it('leaves everything that is not a question card alone', () => {
    expect(cardToAnswerableText('hello')).toBeNull();
    expect(cardToAnswerableText(undefined)).toBeNull();
    expect(cardToAnswerableText({ markdown: '# hi' })).toBeNull();
    // a display card (send_card) has no ncq answer buttons
    expect(cardToAnswerableText(Card({ title: 'Info', children: [CardText('just so you know')] }))).toBeNull();
  });
});

describe('matchAnswer', () => {
  it.each([
    ['1', 0],
    [' 2 ', 1],
    ['3.', 2],
    ['3)', 2],
    ['Approve', 0],
    ['approve!', 0],
    ['REJECT', 1],
    ['reject with reason', 2],
    ['Reject with reason…', 2],
  ])('%j answers option %i', (text, index) => {
    expect(matchAnswer(text, OPTIONS)).toBe(OPTIONS[index]);
  });

  it.each(['', '   ', '0', '4', '12', 'approve please', 'yes', 'ok', 'no thanks', 'what does this do?'])(
    '%j is an ordinary message, not an answer',
    (text) => {
      expect(matchAnswer(text, OPTIONS)).toBeNull();
    },
  );
});

describe('findPendingCard', () => {
  const BOT = '@jorgenclaw:matrix.jorgenclaw.ai';
  const ev = (sender: string, id?: string) => ({
    getSender: () => sender,
    getContent: () => (id ? { body: 'card', [QUESTION_KEY]: { id } } : { body: 'chat' }),
  });

  it('picks the newest card that is still pending', () => {
    const events = [ev(BOT, 'newest'), ev(BOT, 'older')]; // newest first
    expect(findPendingCard(events, BOT, () => true)).toBe('newest');
  });

  it('skips cards that were already answered', () => {
    const events = [ev(BOT, 'answered'), ev(BOT, 'still-open')];
    expect(findPendingCard(events, BOT, (id) => id === 'still-open')).toBe('still-open');
  });

  it("ignores other people's messages, plain chat, and forged markers", () => {
    const events = [ev('@stranger:matrix.jorgenclaw.ai', 'forged'), ev(BOT), ev(BOT, 'real')];
    expect(findPendingCard(events, BOT, () => true)).toBe('real');
  });

  it('returns null when nothing is pending', () => {
    expect(findPendingCard([ev(BOT, 'a')], BOT, () => false)).toBeNull();
    expect(findPendingCard([], BOT, () => true)).toBeNull();
  });
});
