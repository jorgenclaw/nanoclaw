/**
 * Per-agent Matrix accounts ("one account per agent", Scott's choice 2026-09-19).
 *
 * Each sub-agent speaks as its own Matrix user. The accounts are created by an
 * OPERATOR script (scripts/matrix-provision-agent.ts), never from a path an agent
 * can trigger, so the homeserver's registration secret stays out of reach of
 * anything an LLM could be talked into doing. The script leaves one entry per
 * agent folder in data/matrix-agent-accounts.json (mode 0600, gitignored, holds
 * access tokens and no passwords); matrix.ts registers one named adapter
 * instance `matrix-<folder>` per entry at startup.
 *
 * This file is the format: pure helpers plus a small reader/writer, so it can be
 * tested without a homeserver.
 */
import fs from 'fs';
import path from 'path';

export interface AgentAccount {
  /** The agent group's folder name (groups/<folder>). */
  folder: string;
  /** Full Matrix id, e.g. "@coder:matrix.jorgenclaw.ai". */
  userId: string;
  accessToken: string;
  deviceId?: string;
}

export interface ParsedAccounts {
  accounts: AgentAccount[];
  /** Human-readable reasons entries were skipped (never contains a token). */
  problems: string[];
}

export const ACCOUNTS_FILE_NAME = 'matrix-agent-accounts.json';
const FILE_VERSION = 1;

/** What `create_agent` produces for a folder, and safe inside an adapter-instance name. */
const FOLDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** @localpart:server (optionally :port) — the Matrix user id shape. */
const MATRIX_USER_ID = /^@[a-z0-9._=\-/+]+:[a-z0-9.-]+(:\d+)?$/;

/** Adapter-registry key of the account that speaks for an agent folder. */
export function matrixInstanceName(folder: string): string {
  return `matrix-${folder}`;
}

export function isValidAgentFolder(folder: string): boolean {
  return FOLDER.test(folder);
}

export function isValidMatrixUserId(userId: string): boolean {
  return MATRIX_USER_ID.test(userId);
}

/** "@coder:server" → "coder". */
export function matrixLocalpart(userId: string): string {
  return userId.slice(1, userId.indexOf(':'));
}

/** Parse the accounts file. Bad entries are skipped with a reason; one bad entry never hides the rest. */
export function parseAccountsFile(text: string): ParsedAccounts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { accounts: [], problems: ['the file is not valid JSON, so no per-agent accounts were loaded'] };
  }
  const entries = (raw as { accounts?: unknown } | null)?.accounts;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return { accounts: [], problems: ['the file has no "accounts" object'] };
  }

  const accounts: AgentAccount[] = [];
  const problems: string[] = [];
  const seenUsers = new Map<string, string>();
  for (const [folder, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!isValidAgentFolder(folder)) {
      problems.push(`skipped "${folder}": not a valid agent folder name`);
      continue;
    }
    const e = (value ?? {}) as Record<string, unknown>;
    const userId = typeof e.user_id === 'string' ? e.user_id : '';
    const accessToken = typeof e.access_token === 'string' ? e.access_token : '';
    if (!isValidMatrixUserId(userId)) {
      problems.push(`skipped "${folder}": user_id is missing or is not a Matrix user id`);
      continue;
    }
    if (!accessToken) {
      problems.push(`skipped "${folder}": no access_token`);
      continue;
    }
    // Two agents sharing one account would defeat "one account per agent".
    const owner = seenUsers.get(userId);
    if (owner) {
      problems.push(`skipped "${folder}": ${userId} already belongs to "${owner}"`);
      continue;
    }
    seenUsers.set(userId, folder);
    const deviceId = typeof e.device_id === 'string' && e.device_id ? e.device_id : undefined;
    accounts.push({ folder, userId, accessToken, deviceId });
  }
  return { accounts, problems };
}

export function serializeAccounts(accounts: AgentAccount[]): string {
  const out: Record<string, { user_id: string; access_token: string; device_id?: string }> = {};
  for (const a of [...accounts].sort((x, y) => x.folder.localeCompare(y.folder))) {
    out[a.folder] = {
      user_id: a.userId,
      access_token: a.accessToken,
      ...(a.deviceId ? { device_id: a.deviceId } : {}),
    };
  }
  return JSON.stringify({ version: FILE_VERSION, accounts: out }, null, 2) + '\n';
}

/** Read the accounts file. A missing file is normal (no sub-agent has an account yet). */
export function loadAgentAccounts(file: string): ParsedAccounts {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [], problems: [] };
    return { accounts: [], problems: [`could not read ${path.basename(file)}: ${(err as Error).message}`] };
  }
  return parseAccountsFile(text);
}

/** Write the accounts file atomically with owner-only permissions. */
export function saveAgentAccounts(file: string, accounts: AgentAccount[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, serializeAccounts(accounts), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
