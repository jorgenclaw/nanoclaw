/**
 * Each agent account in data/matrix-agent-accounts.json must become its own named
 * adapter instance `matrix-<folder>`; that key is what create_matrix_room's
 * matrixInstanceFor() looks up, so a mismatch would leave the agent "without an account".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import { registerAgentAccountInstances } from './matrix.js';

describe('registerAgentAccountInstances', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-instances-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers matrix-<folder> for each good account and skips bad entries', () => {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        accounts: {
          'test-coder': { user_id: '@test-coder:matrix.example', access_token: 't1' },
          'test-social': { user_id: '@test-social:matrix.example', access_token: 't2', device_id: 'D' },
          'Bad Folder': { user_id: '@x:matrix.example', access_token: 't3' },
        },
      }),
    );

    const registered = registerAgentAccountInstances(file);

    expect(registered).toEqual(['matrix-test-coder', 'matrix-test-social']);
    expect(getRegisteredChannelNames()).toEqual(
      expect.arrayContaining(['matrix', 'matrix-test-coder', 'matrix-test-social']),
    );
    expect(getRegisteredChannelNames()).not.toContain('matrix-Bad Folder');
  });

  it('registers nothing when there is no accounts file', () => {
    expect(registerAgentAccountInstances(path.join(dir, 'missing.json'))).toEqual([]);
  });
});
