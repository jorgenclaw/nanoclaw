/**
 * scripts/matrix-provision-agent.ts — give a sub-agent its own Matrix account.
 *
 * OPERATOR-RUN, on purpose. It needs the homeserver's registration secret, which
 * must never be reachable from anything an agent can trigger. Run it from the
 * repo root under Node 22 (the same Node the service uses):
 *
 *   pnpm exec tsx scripts/matrix-provision-agent.ts <folder> [--display-name "Coder"] [--username coder]
 *   pnpm exec tsx scripts/matrix-provision-agent.ts --list
 *
 * <folder> is the agent group's folder (groups/<folder>), which `create_agent`
 * derives from the agent's name ("Coder" -> "coder"). The script:
 *   1. registers @<username>:<server> through Synapse's shared-secret endpoint, with
 *      a random password that is never shown or saved (the account is used via its
 *      access token; an operator can reset the password later if a login is needed);
 *   2. saves the access token to data/matrix-agent-accounts.json (mode 0600);
 *   3. prints status lines only. It never prints the token, password or secret.
 *
 * The host starts one adapter instance `matrix-<folder>` per saved account, so
 * RESTART THE HOST afterwards. It only ever creates a new account: it refuses to
 * touch an existing one, and refuses an agent that already speaks as the default
 * @jorgenclaw account.
 *
 * Options:
 *   --homeserver <url>       Synapse to talk to (default http://localhost:8008; the public
 *                            /_synapse/admin path is blocked at the Cloudflare tunnel).
 *   --synapse-config <path>  homeserver.yaml holding registration_shared_secret
 *                            (default ~/matrix/synapse-data/homeserver.yaml).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import {
  ACCOUNTS_FILE_NAME,
  isValidAgentFolder,
  isValidMatrixUserId,
  loadAgentAccounts,
  saveAgentAccounts,
} from '../src/channels/matrix-agent-accounts.js';
import { generatePassword, parseSharedSecret, registrationMac } from './matrix-provision-lib.js';

function fail(message: string): never {
  console.error(`ABORT (nothing changed): ${message}`);
  process.exit(1);
}

interface Options {
  folder?: string;
  list: boolean;
  displayName?: string;
  username?: string;
  homeserver: string;
  synapseConfig: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    list: false,
    homeserver: 'http://localhost:8008',
    synapseConfig: path.join(os.homedir(), 'matrix', 'synapse-data', 'homeserver.yaml'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      return v;
    };
    if (a === '--list') opts.list = true;
    else if (a === '--display-name') opts.displayName = value();
    else if (a === '--username') opts.username = value();
    else if (a === '--homeserver') opts.homeserver = value().replace(/\/+$/, '');
    else if (a === '--synapse-config') opts.synapseConfig = value();
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: pnpm exec tsx scripts/matrix-provision-agent.ts <folder> [--display-name "Coder"] [--username coder]\n' +
          '       pnpm exec tsx scripts/matrix-provision-agent.ts --list\n' +
          'Options: --homeserver <url>  --synapse-config <path>   (see the header of this file)',
      );
      process.exit(0);
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else if (!opts.folder) opts.folder = a;
    else fail(`unexpected argument ${a}`);
  }
  return opts;
}

async function listAccounts(file: string, homeserver: string): Promise<void> {
  const { accounts, problems } = loadAgentAccounts(file);
  for (const p of problems) console.log(`note: ${p}`);
  if (accounts.length === 0) {
    console.log('No per-agent Matrix accounts are set up yet.');
    return;
  }
  for (const a of accounts) {
    let status: string;
    try {
      const res = await fetch(`${homeserver}/_matrix/client/v3/account/whoami`, {
        headers: { Authorization: `Bearer ${a.accessToken}` },
      });
      const body = (await res.json().catch(() => ({}))) as { user_id?: string };
      status = res.ok && body.user_id === a.userId ? 'token OK' : `token REJECTED (HTTP ${res.status})`;
    } catch {
      status = 'homeserver unreachable';
    }
    console.log(`${a.folder.padEnd(20)} ${a.userId.padEnd(40)} ${status}`);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join('data', 'v2.db'))) fail('run this from the NanoClaw repo root (data/v2.db not found).');
  const accountsFile = path.join('data', ACCOUNTS_FILE_NAME);

  if (opts.list) {
    await listAccounts(accountsFile, opts.homeserver);
    return;
  }

  const folder = opts.folder;
  if (!folder) fail('give the agent folder, e.g. "coder" (or use --list).');
  if (!isValidAgentFolder(folder))
    fail(`"${folder}" is not a valid agent folder name (lowercase letters, digits, . _ -).`);

  const existing = loadAgentAccounts(accountsFile);
  if (existing.accounts.some((a) => a.folder === folder)) {
    fail(`"${folder}" already has a Matrix account. Nothing to do (see --list).`);
  }

  // What we know about the agent, read-only. The account can be made before the agent exists
  // (it is keyed by folder name), but never for an agent that already speaks as @jorgenclaw.
  const db = new Database(path.join('data', 'v2.db'), { readonly: true, fileMustExist: true });
  const group = db.prepare('SELECT id, name FROM agent_groups WHERE folder = ?').get(folder) as
    | { id: string; name: string }
    | undefined;
  if (group) {
    const onDefault = db
      .prepare(
        `SELECT 1 FROM messaging_group_agents mga JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ? AND mg.channel_type = 'matrix' AND COALESCE(mg.instance, 'matrix') = 'matrix' LIMIT 1`,
      )
      .get(group.id);
    if (onDefault) fail(`"${folder}" already speaks as the default Matrix account, so it does not get its own.`);
  }
  db.close();

  const username = opts.username ?? folder;
  const displayName = opts.displayName ?? group?.name ?? folder[0].toUpperCase() + folder.slice(1);

  let secret: string | null;
  try {
    secret = parseSharedSecret(fs.readFileSync(opts.synapseConfig, 'utf-8'));
  } catch (err) {
    fail(`cannot read ${opts.synapseConfig}: ${(err as Error).message}`);
  }
  if (!secret) fail(`no registration_shared_secret in ${opts.synapseConfig}.`);

  const registerUrl = `${opts.homeserver}/_synapse/admin/v1/register`;
  let nonce: string;
  try {
    const res = await fetch(registerUrl);
    if (!res.ok) fail(`the homeserver answered HTTP ${res.status} to the nonce request.`);
    nonce = ((await res.json()) as { nonce: string }).nonce;
  } catch (err) {
    fail(`cannot reach the homeserver at ${opts.homeserver}: ${(err as Error).message}`);
  }

  // A throwaway password: the account is used through its access token, never a login.
  const password = generatePassword();
  const res = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nonce,
      username,
      displayname: displayName,
      password,
      admin: false,
      mac: registrationMac(secret, nonce, username, password, false),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    user_id?: string;
    access_token?: string;
    device_id?: string;
    errcode?: string;
    error?: string;
  };
  if (!res.ok || !body.user_id || !body.access_token) {
    if (body.errcode === 'M_USER_IN_USE') {
      fail(`the Matrix username "${username}" is already taken. Pick another with --username.`);
    }
    fail(`registration failed (HTTP ${res.status}, ${body.errcode ?? 'no error code'}).`);
  }
  if (!isValidMatrixUserId(body.user_id)) fail(`the homeserver returned an unexpected user id shape.`);

  try {
    saveAgentAccounts(accountsFile, [
      ...existing.accounts,
      { folder, userId: body.user_id, accessToken: body.access_token, deviceId: body.device_id },
    ]);
  } catch (err) {
    // The one failure we cannot undo quietly: the account exists but its token was lost.
    console.error(
      `WARNING: ${body.user_id} was created but its token could NOT be saved (${(err as Error).message}). ` +
        'Deactivate that account on the homeserver before trying again.',
    );
    process.exit(1);
  }

  console.log(`Created ${body.user_id} (display name "${displayName}") for agent folder "${folder}".`);
  console.log(`Access token saved to ${accountsFile} (owner-only). It was not printed.`);
  if (!group) {
    console.log(
      `Note: no agent group with folder "${folder}" exists yet. The account is ready and is used as soon as one is created with that folder name.`,
    );
  }
  console.log('Next: restart the host so it starts the new adapter instance.');
}

main().catch((err) => {
  console.error(`ABORT: ${(err as Error).message}`);
  process.exit(1);
});
