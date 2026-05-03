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
 * "Model not found". We sidecar the last-used model in `.last-model` and wipe
 * the session DB when it changes, forcing a fresh session against the new
 * model. Conversation context is preserved by NanoClaw's outer messages_in/out
 * — only OpenCode's internal session scratchpad is reset.
 */
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

function maybeWipeOnModelChange(
  opencodeDir: string,
  sessionDir: string,
  currentModel: string | undefined,
  sessionId: string,
): void {
  if (!currentModel) return;
  const lastModelPath = path.join(opencodeDir, '.last-model');
  const sessionDbDir = path.join(opencodeDir, 'opencode');
  let lastModel: string | undefined;
  try {
    lastModel = fs.readFileSync(lastModelPath, 'utf8').trim();
  } catch {
    // first run for this session — no previous model recorded
  }
  if (lastModel && lastModel !== currentModel) {
    log.info('OpenCode model changed — wiping session state', {
      sessionId,
      from: lastModel,
      to: currentModel,
    });
    if (fs.existsSync(sessionDbDir)) {
      fs.rmSync(sessionDbDir, { recursive: true, force: true });
    }
    clearAgentRunnerSdkSessionId(sessionDir);
  }
  fs.writeFileSync(lastModelPath, currentModel);
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const currentModel = ctx.containerEnv.OPENCODE_MODEL ?? ctx.hostEnv.OPENCODE_MODEL;
  maybeWipeOnModelChange(opencodeDir, ctx.sessionDir, currentModel, path.basename(ctx.sessionDir));

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost'),
  };
  for (const key of ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL'] as const) {
    const value = ctx.containerEnv[key] ?? ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
