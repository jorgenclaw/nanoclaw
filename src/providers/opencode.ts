/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model to use at runtime
 * (read on the host, injected into the container). NO_PROXY / no_proxy are
 * merged with host values so the in-container OpenCode client can talk to
 * 127.0.0.1 even when HTTPS_PROXY is set by OneCLI.
 *
 * Auto-wipe on model change: OpenCode persists the model name into its session
 * DB. If the user switches models (edit container.json or set a new env), an
 * unmodified resume reads the old model from session and OpenCode errors with
 * "Model not found". We sidecar a model fingerprint in `.last-model` and wipe
 * the session DB when it changes, forcing a fresh session against the new
 * model. Conversation context is preserved by NanoClaw's outer messages_in/out
 * — only OpenCode's internal session scratchpad is reset.
 *
 * The fingerprint is `<model-name>|<modelfile-sha256>` for Ollama models. We
 * hash the output of `ollama show --modelfile <name>` so a Modelfile-only
 * recreate (same name, different weights or params, e.g. swapping q4→q8 or
 * adding `num_predict 8192`) still triggers the wipe. Without the digest,
 * OpenCode would resume the old session against re-baked weights and Ollama
 * silently hangs on the next inference call (300s event-stream timeouts —
 * observed on EVO 2026-05-04 after a Modelfile param change). Non-Ollama
 * providers fall back to name-only (the prior behavior).
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

function clearAgentRunnerSdkSessionId(sessionDir: string): void {
  // The agent-runner caches the OpenCode session ID in outbound.db's
  // session_state table. When we wipe OpenCode's own session DB, this cached
  // ID becomes a dangling reference — the agent-runner will tell OpenCode to
  // resume a session that no longer exists, and OpenCode hangs trying to
  // look it up. Clear the cached ID so the agent-runner starts a brand-new
  // session against the new model.
  const outboundDbPath = path.join(sessionDir, 'outbound.db');
  if (!fs.existsSync(outboundDbPath)) return;
  try {
    const db = new Database(outboundDbPath);
    db.prepare("DELETE FROM session_state WHERE key = 'sdk_session_id'").run();
    db.close();
  } catch (err) {
    // outbound.db might be locked by a running container; the wipe still
    // beats the alternative (silent hang). Log and continue.
    log.warn('Failed to clear sdk_session_id from outbound.db', {
      sessionDir,
      err: (err as Error).message,
    });
  }
}

/**
 * Compute a fingerprint for the current model. Includes the Ollama Modelfile
 * digest (when applicable) so a same-name Modelfile recreate invalidates the
 * cache. Returns the bare model name unchanged for non-Ollama providers or
 * when the Ollama lookup fails (degraded — equivalent to the prior behavior).
 */
function computeModelFingerprint(currentModel: string): string {
  // Recognize Ollama in two forms:
  //   "ollama/gemma4:31b-jorgenclaw" — provider/model syntax
  //   "gemma4:31b-jorgenclaw"        — bare model when OPENCODE_PROVIDER=ollama
  // We can't distinguish the second case from a remote model name without the
  // provider env, so we only auto-detect the explicit "ollama/" prefix here.
  // Bare names still work — they just won't get a digest, falling back to
  // name-only comparison.
  const ollamaPrefix = 'ollama/';
  if (!currentModel.startsWith(ollamaPrefix)) return currentModel;
  const ollamaName = currentModel.slice(ollamaPrefix.length);
  try {
    const modelfile = execFileSync('ollama', ['show', '--modelfile', ollamaName], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const digest = crypto.createHash('sha256').update(modelfile).digest('hex').slice(0, 16);
    return `${currentModel}|${digest}`;
  } catch (err) {
    log.warn('OpenCode auto-wipe: Ollama digest probe failed — falling back to name-only', {
      model: currentModel,
      err: (err as Error).message,
    });
    return currentModel;
  }
}

function maybeWipeOnModelChange(
  opencodeDir: string,
  sessionDir: string,
  currentModel: string | undefined,
  sessionId: string,
): void {
  if (!currentModel) return;
  const lastModelPath = path.join(opencodeDir, '.last-model');
  const sessionDbDir = path.join(opencodeDir, 'opencode');
  const currentFingerprint = computeModelFingerprint(currentModel);
  let lastFingerprint: string | undefined;
  try {
    lastFingerprint = fs.readFileSync(lastModelPath, 'utf8').trim();
  } catch {
    // first run for this session — no previous model recorded
  }
  if (lastFingerprint && lastFingerprint !== currentFingerprint) {
    log.info('OpenCode model changed — wiping session state', {
      sessionId,
      from: lastFingerprint,
      to: currentFingerprint,
    });
    if (fs.existsSync(sessionDbDir)) {
      fs.rmSync(sessionDbDir, { recursive: true, force: true });
    }
    clearAgentRunnerSdkSessionId(sessionDir);
  }
  fs.writeFileSync(lastModelPath, currentFingerprint);
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const currentModel = (ctx.containerEnv ?? {}).OPENCODE_MODEL ?? ctx.hostEnv.OPENCODE_MODEL;
  maybeWipeOnModelChange(opencodeDir, ctx.sessionDir, currentModel, path.basename(ctx.sessionDir));

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  for (const key of ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL'] as const) {
    const value = (ctx.containerEnv ?? {})[key] ?? ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
