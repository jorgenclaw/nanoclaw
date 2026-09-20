import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isValidAgentFolder,
  loadAgentAccounts,
  matrixInstanceName,
  matrixLocalpart,
  parseAccountsFile,
  saveAgentAccounts,
  serializeAccounts,
} from './matrix-agent-accounts.js';

const good = { user_id: '@coder:matrix.jorgenclaw.ai', access_token: 'tok-coder', device_id: 'DEV1' };

describe('matrixInstanceName / matrixLocalpart / isValidAgentFolder', () => {
  it('names the instance after the folder', () => {
    expect(matrixInstanceName('coder')).toBe('matrix-coder');
  });

  it('extracts the localpart', () => {
    expect(matrixLocalpart('@coder:matrix.jorgenclaw.ai')).toBe('coder');
  });

  it('accepts folders create_agent can produce and rejects unsafe ones', () => {
    expect(isValidAgentFolder('coder')).toBe(true);
    expect(isValidAgentFolder('lauren-moore')).toBe(true);
    expect(isValidAgentFolder('coder-2')).toBe(true);
    expect(isValidAgentFolder('')).toBe(false);
    expect(isValidAgentFolder('Coder')).toBe(false);
    expect(isValidAgentFolder('../etc')).toBe(false);
    expect(isValidAgentFolder('a b')).toBe(false);
    expect(isValidAgentFolder('-lead')).toBe(false);
  });
});

describe('parseAccountsFile', () => {
  it('reads a well-formed file', () => {
    const r = parseAccountsFile(JSON.stringify({ version: 1, accounts: { coder: good } }));
    expect(r.problems).toEqual([]);
    expect(r.accounts).toEqual([
      { folder: 'coder', userId: '@coder:matrix.jorgenclaw.ai', accessToken: 'tok-coder', deviceId: 'DEV1' },
    ]);
  });

  it('treats a missing device id as optional', () => {
    const r = parseAccountsFile(
      JSON.stringify({ accounts: { coder: { user_id: good.user_id, access_token: good.access_token } } }),
    );
    expect(r.accounts[0].deviceId).toBeUndefined();
  });

  it('skips a bad entry without hiding the good ones, and never echoes a token', () => {
    const r = parseAccountsFile(
      JSON.stringify({
        accounts: {
          coder: good,
          'Bad Folder': good,
          social: { user_id: 'not-an-id', access_token: 'SECRET-TOKEN-VALUE' },
          notoken: { user_id: '@notoken:matrix.jorgenclaw.ai' },
        },
      }),
    );
    expect(r.accounts.map((a) => a.folder)).toEqual(['coder']);
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join(' ')).not.toContain('SECRET-TOKEN-VALUE');
  });

  it('refuses two agents sharing one Matrix account', () => {
    const r = parseAccountsFile(
      JSON.stringify({ accounts: { coder: good, social: { user_id: good.user_id, access_token: 'other' } } }),
    );
    expect(r.accounts.map((a) => a.folder)).toEqual(['coder']);
    expect(r.problems[0]).toMatch(/already belongs to "coder"/);
  });

  it('survives garbage', () => {
    expect(parseAccountsFile('not json').accounts).toEqual([]);
    expect(parseAccountsFile('not json').problems).toHaveLength(1);
    expect(parseAccountsFile('null').problems).toHaveLength(1);
    expect(parseAccountsFile('{"accounts": []}').problems).toHaveLength(1);
    expect(parseAccountsFile('{}').accounts).toEqual([]);
  });
});

describe('serializeAccounts', () => {
  it('round-trips through parse, sorted by folder', () => {
    const accounts = [
      { folder: 'social', userId: '@social:matrix.jorgenclaw.ai', accessToken: 't2' },
      { folder: 'coder', userId: '@coder:matrix.jorgenclaw.ai', accessToken: 't1', deviceId: 'D' },
    ];
    const text = serializeAccounts(accounts);
    expect(text.indexOf('"coder"')).toBeLessThan(text.indexOf('"social"'));
    const back = parseAccountsFile(text);
    expect(back.problems).toEqual([]);
    expect(back.accounts.map((a) => a.folder)).toEqual(['coder', 'social']);
    expect(back.accounts[0].deviceId).toBe('D');
  });
});

describe('loadAgentAccounts / saveAgentAccounts', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-accounts-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a missing file is normal: no accounts, no problems', () => {
    expect(loadAgentAccounts(path.join(dir, 'nope.json'))).toEqual({ accounts: [], problems: [] });
  });

  it('saves atomically with owner-only permissions and loads it back', () => {
    const file = path.join(dir, 'data', 'accounts.json');
    saveAgentAccounts(file, [{ folder: 'coder', userId: good.user_id, accessToken: good.access_token }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['accounts.json']); // no temp file left behind
    expect(loadAgentAccounts(file).accounts.map((a) => a.folder)).toEqual(['coder']);
  });

  it('keeps owner-only permissions when replacing an existing file', () => {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    saveAgentAccounts(file, [{ folder: 'coder', userId: good.user_id, accessToken: good.access_token }]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reports an unreadable file as a problem instead of throwing', () => {
    const r = loadAgentAccounts(dir); // a directory, not a file
    expect(r.accounts).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });
});
