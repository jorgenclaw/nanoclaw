import { describe, expect, it } from 'vitest';

import { generatePassword, parseSharedSecret, registrationMac } from './matrix-provision-lib.js';

describe('registrationMac', () => {
  // Expected values were computed independently with Python's hmac/hashlib, following Synapse's
  // documented recipe: HMAC-SHA1(secret, nonce \0 username \0 password \0 admin|notadmin).
  it('matches the reference value for a non-admin account', () => {
    expect(registrationMac('test-secret', 'abc123', 'coder', 'pw-1234')).toBe(
      '1825d480070a6e60fbca0af7e6b11713f0dad5e2',
    );
  });

  it('signs "admin" for an admin account (a different value)', () => {
    expect(registrationMac('test-secret', 'abc123', 'coder', 'pw-1234', true)).toBe(
      'a89797e124dccb2ce1133441cf7e2003be93d4ed',
    );
  });

  it('changes when any input changes', () => {
    const base = registrationMac('s', 'n', 'u', 'p');
    expect(registrationMac('s2', 'n', 'u', 'p')).not.toBe(base);
    expect(registrationMac('s', 'n2', 'u', 'p')).not.toBe(base);
    expect(registrationMac('s', 'n', 'u2', 'p')).not.toBe(base);
    expect(registrationMac('s', 'n', 'u', 'p2')).not.toBe(base);
  });
});

describe('parseSharedSecret', () => {
  it('reads a double-quoted, single-quoted and bare value', () => {
    expect(parseSharedSecret('registration_shared_secret: "abc def"\n')).toBe('abc def');
    expect(parseSharedSecret("registration_shared_secret: 'abc'\n")).toBe('abc');
    expect(parseSharedSecret('registration_shared_secret: abc\n')).toBe('abc');
  });

  it('ignores a trailing comment on a bare value', () => {
    expect(parseSharedSecret('registration_shared_secret: abc   # keep safe\n')).toBe('abc');
  });

  it('finds it among other settings and ignores commented-out or indented lines', () => {
    const yaml = [
      'server_name: "matrix.example"',
      '#registration_shared_secret: "nope"',
      '  registration_shared_secret: "nested"',
      'registration_shared_secret: "real"',
      'report_stats: false',
    ].join('\n');
    expect(parseSharedSecret(yaml)).toBe('real');
  });

  it('returns null when absent or empty', () => {
    expect(parseSharedSecret('server_name: x\n')).toBeNull();
    expect(parseSharedSecret('registration_shared_secret:\n')).toBeNull();
    expect(parseSharedSecret('registration_shared_secret: ""\n')).toBeNull();
  });
});

describe('generatePassword', () => {
  it('is 32 URL-safe characters and different every time', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});
