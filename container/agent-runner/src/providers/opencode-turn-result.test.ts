import { describe, expect, test } from 'bun:test';

import { TurnResultTracker } from './opencode-turn-result.js';

type Msg = { id: string; role: 'user' | 'assistant'; summary?: boolean; finish?: string };

const msg = (t: TurnResultTracker, m: Msg) => t.onMessageUpdated(m);
const text = (t: TurnResultTracker, messageID: string, body: string) =>
  t.onPartUpdated({ type: 'text', messageID, text: body });
const compactionMarker = (t: TurnResultTracker, messageID: string) =>
  t.onPartUpdated({ type: 'compaction', messageID });

describe('TurnResultTracker without compaction', () => {
  test('returns the text of the only assistant message', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'u1', role: 'user' });
    msg(t, { id: 'a1', role: 'assistant' });
    text(t, 'a1', 'hello');
    msg(t, { id: 'a1', role: 'assistant', finish: 'stop' });
    expect(t.resultText()).toBe('hello');
  });

  test('the last assistant message with text wins across tool-call steps', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant', finish: 'tool-calls' });
    text(t, 'a1', 'Let me look that up.');
    msg(t, { id: 'a2', role: 'assistant', finish: 'tool-calls' }); // tools only, no text
    msg(t, { id: 'a3', role: 'assistant', finish: 'stop' });
    text(t, 'a3', 'Here is the answer.');
    expect(t.resultText()).toBe('Here is the answer.');
  });

  test('a later text-less message does not erase an earlier reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant', finish: 'stop' });
    text(t, 'a1', 'the reply');
    msg(t, { id: 'a2', role: 'assistant', finish: 'stop' });
    expect(t.resultText()).toBe('the reply');
  });

  test('user message text is never the reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'u1', role: 'user' });
    text(t, 'u1', 'what the user said');
    expect(t.resultText()).toBe('');
  });

  test('an empty tracker returns an empty string', () => {
    expect(new TurnResultTracker().resultText()).toBe('');
  });

  test('ignores events that carry no ids', () => {
    const t = new TurnResultTracker();
    t.onMessageUpdated(undefined);
    t.onMessageUpdated({ role: 'assistant' });
    t.onPartUpdated(undefined);
    t.onPartUpdated({ type: 'text', text: 'orphan' });
    expect(t.resultText()).toBe('');
  });
});

describe('TurnResultTracker with compaction', () => {
  // Replays the event order of Lauren Moore's 2026-09-21 turn, with the real
  // message ids. The full answer finished with finish "stop" and tipped the
  // session over the window; OpenCode then compacted, injected "Continue if you
  // have next steps ...", and the model answered that with a recap.
  const FULL_ANSWER = '<message to="lauren">Here is the full crowd-calendar summary ...</message>';
  const RECAP = 'Hi Lauren! Completed: ... Disneyland Thanksgiving 2026 crowd forecast. No pending follow-ups.';

  function replayIncident(t: TurnResultTracker, { withCompactionPart }: { withCompactionPart: boolean }) {
    msg(t, { id: '0c63a6c79001', role: 'user' });
    msg(t, { id: '0c63a6c81001', role: 'assistant' });
    text(t, '0c63a6c81001', '<message to="lauren">Here is the full');
    text(t, '0c63a6c81001', FULL_ANSWER);
    msg(t, { id: '0c63a6c81001', role: 'assistant', finish: 'stop' });

    msg(t, { id: '0c63b014d001', role: 'user' }); // compaction marker
    if (withCompactionPart) compactionMarker(t, '0c63b014d001');
    msg(t, { id: '0c63b0156001', role: 'assistant', summary: true });
    text(t, '0c63b0156001', '## Goal\n... a long compaction summary ...');
    msg(t, { id: '0c63b0156001', role: 'assistant', summary: true, finish: 'stop' });

    msg(t, { id: '0c63f78bf001', role: 'user' }); // synthetic "Continue if you have next steps"
    text(t, '0c63f78bf001', 'Continue if you have next steps, or stop and ask for clarification ...');
    msg(t, { id: '0c63f78c5001', role: 'assistant' });
    text(t, '0c63f78c5001', RECAP);
    msg(t, { id: '0c63f78c5001', role: 'assistant', finish: 'stop' });
  }

  test('keeps the reply that finished before compaction, not the recap after it', () => {
    const t = new TurnResultTracker();
    replayIncident(t, { withCompactionPart: true });
    expect(t.resultText()).toBe(FULL_ANSWER);
  });

  test('still works when only the summary message marks the compaction boundary', () => {
    const t = new TurnResultTracker();
    replayIncident(t, { withCompactionPart: false });
    expect(t.resultText()).toBe(FULL_ANSWER);
  });

  test('a second compaction later in the turn does not move the boundary', () => {
    const t = new TurnResultTracker();
    replayIncident(t, { withCompactionPart: true });
    msg(t, { id: 'u-marker-2', role: 'user' });
    compactionMarker(t, 'u-marker-2');
    msg(t, { id: 's2', role: 'assistant', summary: true });
    text(t, 's2', 'second summary');
    expect(t.resultText()).toBe(FULL_ANSWER);
  });

  test('a compaction summary is never returned as the reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant' }); // produced no text
    msg(t, { id: 's1', role: 'assistant', summary: true });
    text(t, 's1', 'a ~20k-char compaction summary');
    expect(t.resultText()).toBe('');
  });

  test('mid-turn compaction after a tool-call step: the post-compaction message is the real reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant', finish: 'tool-calls' }); // interrupted, not finished
    text(t, 'a1', 'Let me check the prices.');
    compactionMarker(t, 'marker');
    msg(t, { id: 's1', role: 'assistant', summary: true });
    text(t, 's1', 'summary');
    msg(t, { id: 'u2', role: 'user' });
    msg(t, { id: 'a2', role: 'assistant', finish: 'stop' });
    text(t, 'a2', 'Diesel is $5.49 at the cheapest station.');
    expect(t.resultText()).toBe('Diesel is $5.49 at the cheapest station.');
  });

  test('overflow recovery: an unfinished pre-compaction message does not shadow the recovered reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant' }); // errored on overflow: no finish
    text(t, 'a1', 'partial ...');
    compactionMarker(t, 'marker');
    msg(t, { id: 's1', role: 'assistant', summary: true });
    msg(t, { id: 'a2', role: 'assistant', finish: 'stop' });
    text(t, 'a2', 'the recovered reply');
    expect(t.resultText()).toBe('the recovered reply');
  });

  test('a finished pre-compaction message with no text falls back to the post-compaction text', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant', finish: 'stop' }); // stopped without saying anything
    compactionMarker(t, 'marker');
    msg(t, { id: 'a2', role: 'assistant', finish: 'stop' });
    text(t, 'a2', 'after compaction');
    expect(t.resultText()).toBe('after compaction');
  });

  test('a finish reason other than "stop" (e.g. "length") is not treated as a finished reply', () => {
    const t = new TurnResultTracker();
    msg(t, { id: 'a1', role: 'assistant', finish: 'length' });
    text(t, 'a1', 'cut off mid-sente');
    compactionMarker(t, 'marker');
    msg(t, { id: 'a2', role: 'assistant', finish: 'stop' });
    text(t, 'a2', 'continued answer');
    expect(t.resultText()).toBe('continued answer');
  });
});
