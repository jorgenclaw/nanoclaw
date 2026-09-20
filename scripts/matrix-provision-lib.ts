/**
 * Pure helpers for scripts/matrix-provision-agent.ts (kept apart so they can be
 * unit-tested without touching a homeserver).
 */
import crypto from 'crypto';

/**
 * Synapse's shared-secret registration MAC: HMAC-SHA1 keyed with the server's
 * registration_shared_secret over nonce, username, password and the admin flag,
 * NUL-separated. A non-admin account MUST sign the literal "notadmin".
 */
export function registrationMac(
  secret: string,
  nonce: string,
  username: string,
  password: string,
  admin = false,
): string {
  const h = crypto.createHmac('sha1', secret);
  for (const part of [nonce, username, password]) {
    h.update(part);
    h.update('\0');
  }
  h.update(admin ? 'admin' : 'notadmin');
  return h.digest('hex');
}

/** Read `registration_shared_secret` out of homeserver.yaml text (quoted or bare). Returns null if absent. */
export function parseSharedSecret(yaml: string): string | null {
  for (const line of yaml.split('\n')) {
    const m = /^registration_shared_secret:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1];
    const quoted = /^(["'])(.*?)\1/.exec(raw);
    const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '');
    return value || null;
  }
  return null;
}

/** A throwaway 32-character password. It is never shown or stored: the account is used through its access token. */
export function generatePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}
