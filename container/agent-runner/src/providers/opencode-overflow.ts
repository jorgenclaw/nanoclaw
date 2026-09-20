/**
 * Context-window overflow handling for the OpenCode provider.
 *
 * When a prompt outgrows the model's context window, OpenCode publishes a
 * `session.error`, then compacts the session and finishes the turn on its own
 * (seen with OpenCode 1.4.17 against Ollama's llama.cpp runner). The provider
 * used to treat that `session.error` as fatal: it threw, the raw provider JSON
 * was posted to the chat, and the user's request was dropped even though
 * OpenCode recovered a few minutes later.
 */

const CONTEXT_OVERFLOW_RE = new RegExp(
  [
    'exceed_context_size_error', // llama.cpp server error type (Ollama's runner)
    'exceeds the available context size', // llama.cpp server message
    'ContextOverflowError', // OpenCode's own named error
    'context[_ ]length[_ ]exceeded', // OpenAI-style error code
    'maximum context length', // OpenRouter / DeepSeek
    'prompt is too long', // Anthropic
    'exceeds the context window', // OpenAI-compatible
  ].join('|'),
  'i',
);

/** True when a `session.error` payload says the prompt did not fit the context window. */
export function isContextOverflowError(error: unknown): boolean {
  if (error === undefined || error === null) return false;
  let text: string | undefined;
  try {
    // The payload is either a named error ({ name, data: { message } }) or the
    // raw provider body; stringifying it covers both shapes.
    text = typeof error === 'string' ? error : JSON.stringify(error);
  } catch {
    return false;
  }
  return text !== undefined && CONTEXT_OVERFLOW_RE.test(text);
}

/**
 * Shown to the user when OpenCode could not recover from an overflow. It must
 * not match the provider's STALE_SESSION_RE (no "not found", "404", ...), or
 * the poll loop would also discard the stored session.
 */
export const CONTEXT_OVERFLOW_USER_MESSAGE =
  "This conversation got too long for my memory window and automatic trimming didn't fix it. Send /clear to start fresh, then repeat your request.";
