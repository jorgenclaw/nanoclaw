/**
 * Proton Pass client — wraps pass-cli for vault/item/TOTP operations.
 * Uses execFile (not exec) to prevent shell injection.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const PASS_BIN = process.env.PROTON_PASS_BIN || 'pass-cli';
const DEFAULT_VAULT = process.env.PROTON_PASS_VAULT || 'NanoClaw';

// pass-cli looks at $XDG_DATA_HOME/proton-pass-cli/ for its session/db.
// In the agent container we mount host's ~/.local/share/proton-pass-cli at
// /workspace/extra/proton-pass-cli — so point pass-cli at /workspace/extra.
// PROTON_PASS_KEY_PROVIDER=fs avoids the gnome-keyring lookup that has no
// service inside the container.
//
// We FORCE-override XDG_DATA_HOME for the pass-cli child process because the
// agent container sets XDG_DATA_HOME=/opencode-xdg (for OpenCode's session
// state) — that value would make pass-cli look in the wrong place. The
// container check is loose: anything not on the host's normal data path
// triggers the override.
const FORCE_PASS_DATA_HOME = '/workspace/extra';
const looksLikeContainer =
  process.env.XDG_DATA_HOME?.startsWith('/opencode-xdg') ||
  process.env.HOME === '/home/node';
const PASS_ENV = {
  ...process.env,
  PROTON_PASS_KEY_PROVIDER: 'fs',
  XDG_DATA_HOME: looksLikeContainer
    ? FORCE_PASS_DATA_HOME
    : process.env.XDG_DATA_HOME || FORCE_PASS_DATA_HOME,
};

async function runPass(args, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(PASS_BIN, [...args, '--output', 'json'], {
    timeout,
    env: PASS_ENV,
  });
  return JSON.parse(stdout);
}

async function runPassRaw(args, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(PASS_BIN, args, {
    timeout,
    env: PASS_ENV,
  });
  return stdout.trim();
}

export async function listVaults() {
  return runPass(['vault', 'list']);
}

export async function listItems(vault = DEFAULT_VAULT) {
  // item list takes vault name as a positional argument
  return runPass(['item', 'list', vault]);
}

export async function viewItem(title, vault = DEFAULT_VAULT) {
  return runPass(['item', 'view', '--item-title', title, '--vault-name', vault]);
}

export async function searchItems(query, vault = DEFAULT_VAULT) {
  // pass-cli has no search command — filter item list client-side
  const result = await listItems(vault);
  const q = query.toLowerCase();
  const matched = (result.items || []).filter((item) => {
    const t = item.content?.title?.toLowerCase() || '';
    const u = item.content?.content?.Login?.username?.toLowerCase() || '';
    const urls = (item.content?.content?.Login?.urls || []).join(' ').toLowerCase();
    return t.includes(q) || u.includes(q) || urls.includes(q);
  });
  return { items: matched };
}

export async function createItem({ title, username, password, url, notes, vault = DEFAULT_VAULT }) {
  const args = ['item', 'create', 'login',
    '--vault-name', vault,
    '--title', title,
  ];
  if (username) args.push('--username', username);
  if (password) args.push('--password', password);
  if (url) args.push('--url', url);
  // pass-cli create doesn't support --note; notes not available on create
  return runPassRaw(args);
}

export async function updateItem(title, updates, vault = DEFAULT_VAULT) {
  const args = ['item', 'update', '--item-title', title, '--vault-name', vault];
  for (const [key, value] of Object.entries(updates)) {
    if (value) args.push('--field', `${key}=${value}`);
  }
  return runPassRaw(args);
}

export async function trashItem(title, vault = DEFAULT_VAULT) {
  return runPassRaw(['item', 'trash', '--item-title', title, '--vault-name', vault]);
}

export async function getTOTP(title, vault = DEFAULT_VAULT) {
  return runPass(['item', 'totp', '--item-title', title, '--vault-name', vault]);
}
