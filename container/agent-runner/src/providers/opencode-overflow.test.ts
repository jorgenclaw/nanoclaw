import { describe, expect, test } from 'bun:test';

import { CONTEXT_OVERFLOW_USER_MESSAGE, isContextOverflowError } from './opencode-overflow.js';
import { OpenCodeProvider } from './opencode.js';

// The body Ollama's llama.cpp runner returned on 2026-09-19.
const LLAMA_CPP_BODY = {
  error: {
    code: 400,
    message: 'request (135561 tokens) exceeds the available context size (131072 tokens), try increasing it',
    type: 'exceed_context_size_error',
    n_prompt_tokens: 135561,
    n_ctx: 131072,
  },
};

describe('isContextOverflowError', () => {
  test('matches the raw llama.cpp body', () => {
    expect(isContextOverflowError(LLAMA_CPP_BODY)).toBe(true);
  });

  test('matches the body wrapped as a named error with a JSON-string message', () => {
    expect(isContextOverflowError({ name: 'UnknownError', data: { message: JSON.stringify(LLAMA_CPP_BODY) } })).toBe(
      true,
    );
  });

  test('matches OpenCode named overflow errors and other providers wording', () => {
    expect(isContextOverflowError({ name: 'ContextOverflowError', data: { message: 'too big' } })).toBe(true);
    expect(isContextOverflowError({ data: { message: 'prompt is too long: 250000 tokens > 200000 maximum' } })).toBe(
      true,
    );
    expect(isContextOverflowError("This model's maximum context length is 32768 tokens")).toBe(true);
  });

  test('ignores unrelated errors', () => {
    expect(isContextOverflowError({ name: 'APIError', data: { message: 'rate limit exceeded' } })).toBe(false);
    expect(isContextOverflowError({ data: { message: 'Cannot read properties of undefined (reading context)' } })).toBe(
      false,
    );
    expect(isContextOverflowError('boom')).toBe(false);
  });

  test('handles missing and unserializable payloads without throwing', () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError(null)).toBe(false);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isContextOverflowError(circular)).toBe(false);
  });
});

describe('CONTEXT_OVERFLOW_USER_MESSAGE', () => {
  test('does not make the poll loop discard the stored session', () => {
    expect(new OpenCodeProvider().isSessionInvalid(new Error(CONTEXT_OVERFLOW_USER_MESSAGE))).toBe(false);
  });

  test('is plain language and tells the user what to do', () => {
    expect(CONTEXT_OVERFLOW_USER_MESSAGE).toContain('/clear');
    expect(CONTEXT_OVERFLOW_USER_MESSAGE).not.toContain('{');
  });
});
