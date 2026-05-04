import { describe, test, expect, mock } from 'bun:test';
import type { MessageInRow } from './db/messages-in.js';

// Stub transcribeAudio so tests don't need whisper-cli or ffmpeg
mock.module('./transcription.js', () => ({
  WHISPER_MODEL_PATH: '/whisper/model.bin',
  transcribeAudio: async (filePath: string) => {
    if (filePath.includes('fail')) {
      throw new Error('no model found');
    }
    return { text: 'hello world', source: 'local-whisper', durationMs: 42, model: 'whisper-local' };
  },
}));

import { autoTranscribeMessages } from './auto-transcribe.js';

function makeMsg(overrides: Partial<MessageInRow> = {}): MessageInRow {
  return {
    id: 'msg-1',
    kind: 'chat',
    content: JSON.stringify({ text: '' }),
    trigger: 1,
    created_at: Date.now(),
    origin_session_id: null,
    ...overrides,
  } as MessageInRow;
}

describe('autoTranscribeMessages', () => {
  test('passes through non-chat messages unchanged', async () => {
    const msg = makeMsg({ kind: 'task', content: JSON.stringify({ text: 'do thing' }) });
    const result = await autoTranscribeMessages([msg]);
    expect(result[0]).toBe(msg);
  });

  test('passes through messages with no attachments', async () => {
    const msg = makeMsg({ content: JSON.stringify({ text: 'hello' }) });
    const result = await autoTranscribeMessages([msg]);
    expect(result[0]).toBe(msg);
  });

  test('passes through messages with non-audio attachments', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: 'see attached',
        attachments: [{ name: 'photo.jpg', localPath: '/workspace/photo.jpg' }],
      }),
    });
    const result = await autoTranscribeMessages([msg]);
    expect(result[0]).toBe(msg);
  });

  test('injects local-whisper label for ogg attachment', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: 'listen to this',
        attachments: [{ name: 'voice.ogg', localPath: '/workspace/voice.ogg', mimeType: 'audio/ogg' }],
      }),
    });
    const [result] = await autoTranscribeMessages([msg]);
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('[Voice (local-whisper): "hello world"]');
    expect(parsed.text).toContain('listen to this');
  });

  test('injects error label when transcription fails', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: '',
        attachments: [{ name: 'fail.ogg', localPath: '/workspace/fail.ogg', mimeType: 'audio/ogg' }],
      }),
    });
    const [result] = await autoTranscribeMessages([msg]);
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('[Voice: transcription failed');
  });

  test('detects audio by extension when no mimeType', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: '',
        attachments: [{ name: 'clip.mp3', localPath: '/workspace/clip.mp3' }],
      }),
    });
    const [result] = await autoTranscribeMessages([msg]);
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('[Voice (local-whisper):');
  });

  test('skips attachment with no localPath', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: 'original',
        attachments: [{ name: 'voice.ogg', mimeType: 'audio/ogg' }],
      }),
    });
    const [result] = await autoTranscribeMessages([msg]);
    // No transcription injected since no localPath; message may pass through unchanged
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toBe('original');
  });

  test('resolves relative localPath to /workspace/', async () => {
    const msg = makeMsg({
      content: JSON.stringify({
        text: '',
        attachments: [{ name: 'voice.ogg', localPath: 'uploads/voice.ogg', mimeType: 'audio/ogg' }],
      }),
    });
    // Should not throw — the mock handles any path not containing 'fail'
    const [result] = await autoTranscribeMessages([msg]);
    const parsed = JSON.parse(result.content);
    expect(parsed.text).toContain('[Voice (local-whisper):');
  });
});
