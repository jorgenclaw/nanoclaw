/**
 * Proton SRP-6a implementation.
 *
 * Ported from ProtonMail/go-srp and emersion/hydroxide (Go reference
 * implementations).  The math follows standard SRP-6a with Proton-specific
 * choices:
 *
 *   - 2048-bit modulus (little-endian byte encoding, PGP-signed by Proton)
 *   - Generator g = 2
 *   - Hash function H = expandHash  (4× SHA-512, 256-byte output)
 *   - Password key derivation: bcrypt($2y$10$, password, bcryptBase64(salt + "proton"))
 *     → full 60-char bcrypt string → append modulus bytes → expandHash
 *
 * References:
 *   https://github.com/ProtonMail/go-srp
 *   https://github.com/emersion/hydroxide/blob/master/protonmail/srp.go
 *   https://github.com/emersion/hydroxide/blob/master/protonmail/password.go
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

// ─── Byte / BigInt helpers (little-endian, matching Proton convention) ────────

/** Convert a little-endian Uint8Array to a non-negative BigInt. */
export function bytesToBigInt(buf) {
  // Reverse to big-endian, then interpret as unsigned hex.
  const hex = Buffer.from(buf).reverse().toString('hex');
  if (hex.length === 0) return 0n;
  return BigInt('0x' + hex);
}

/** Convert a non-negative BigInt to a little-endian Uint8Array of `len` bytes. */
export function bigIntToBytes(n, len) {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  const be = Buffer.from(hex, 'hex');
  // Reverse big-endian to little-endian, then copy into zero-padded output.
  const le = Buffer.from(be).reverse();
  const buf = Buffer.alloc(len);
  le.copy(buf, 0, 0, Math.min(le.length, len));
  return Uint8Array.from(buf);
}

// ─── Modular arithmetic (using Node.js BigInt) ───────────────────────────────

function mod(a, m) {
  return ((a % m) + m) % m;
}

function modPow(base, exp, m) {
  // Use Node.js crypto DiffieHellman for constant-ish time modPow when
  // possible, but BigInt's built-in is fine for our purposes.
  base = mod(base, m);
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m);
    exp >>= 1n;
    base = mod(base * base, m);
  }
  return result;
}

// ─── Hash functions ──────────────────────────────────────────────────────────

/**
 * Proton's expandHash: SHA-512 with index bytes appended, 4 iterations,
 * concatenated → 256-byte output (2048 bits, matching the modulus size).
 *
 *   expandHash(input) = SHA512(input||0) || SHA512(input||1)
 *                     || SHA512(input||2) || SHA512(input||3)
 */
export function expandHash(input) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const h = crypto.createHash('sha512');
    h.update(Buffer.from(input));
    h.update(Buffer.from([i]));
    parts.push(h.digest());
  }
  return Buffer.concat(parts);  // 64 × 4 = 256 bytes
}

// ─── Bcrypt (Proton-flavored) ────────────────────────────────────────────────

// Bcrypt uses a non-standard base64 alphabet.
const BCRYPT_B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Encode raw bytes to bcrypt's custom base64 (no padding).
 * Ported from the reference C/Java bcrypt implementation.
 * For 16 input bytes, produces exactly 22 characters.
 */
function bcryptBase64Encode(data, len) {
  if (len === undefined) len = data.length;
  let off = 0, out = '';
  while (off < len) {
    let c1 = data[off++] & 0xff;
    out += BCRYPT_B64[(c1 >> 2) & 0x3f];
    c1 = (c1 & 0x03) << 4;
    if (off >= len) { out += BCRYPT_B64[c1 & 0x3f]; break; }
    let c2 = data[off++] & 0xff;
    c1 |= (c2 >> 4) & 0x0f;
    out += BCRYPT_B64[c1 & 0x3f];
    c1 = (c2 & 0x0f) << 2;
    if (off >= len) { out += BCRYPT_B64[c1 & 0x3f]; break; }
    c2 = data[off++] & 0xff;
    c1 |= (c2 >> 6) & 0x03;
    out += BCRYPT_B64[c1 & 0x3f];
    out += BCRYPT_B64[c2 & 0x3f];
  }
  return out;
}

/**
 * Hash a password for Proton SRP (version 3 / 4).
 *
 * @param {string}     password  - UTF-8 password
 * @param {Uint8Array} salt      - from AuthInfo.Salt (base64-decoded)
 * @param {Uint8Array} modulus   - from AuthInfo.Modulus (verified, base64-decoded)
 * @returns {Uint8Array} 256-byte hashed password (little-endian 2048-bit number)
 */
export function hashPassword(password, salt, modulus) {
  // 1. Extend salt with the literal bytes "proton".
  const saltExtended = Buffer.concat([
    Buffer.from(salt),
    Buffer.from('proton', 'utf8'),
  ]);

  // 2. Encode the first 16 bytes of the extended salt in bcrypt base64.
  //    bcrypt expects exactly 22 characters of encoded salt.
  const encodedSalt = bcryptBase64Encode(saltExtended.subarray(0, 16), 16);

  // 3. Build the full bcrypt salt string: $2y$10$ + 22-char encoded salt.
  //    bcryptjs uses $2a$ internally but Proton requires $2y$. We construct
  //    $2a$ (which bcryptjs accepts), then replace in the output.
  const bcryptSalt = '$2a$10$' + encodedSalt.slice(0, 22);

  // 4. bcrypt hash the password.
  let hashed = bcrypt.hashSync(password, bcryptSalt);

  // 5. Replace $2a$ prefix with $2y$ (Proton convention — the prefix is
  //    part of the bytes that feed into SHA-512, so it must match).
  hashed = hashed.replace('$2a$', '$2y$');

  // 6. Concatenate the full bcrypt string (as bytes) with the modulus bytes.
  const combined = Buffer.concat([
    Buffer.from(hashed, 'utf8'),
    Buffer.from(modulus),
  ]);

  // 7. Expand to 256 bytes.
  return expandHash(combined);
}

// ─── SRP proof generation ────────────────────────────────────────────────────

/**
 * Generate SRP-6a client proofs.
 *
 * @param {number}     byteLength         - modulus byte length (256 for 2048-bit)
 * @param {Uint8Array} hashedPasswordBytes - from hashPassword()
 * @param {Uint8Array} modulusBytes        - verified modulus bytes
 * @param {Uint8Array} serverEphemeralBytes - from AuthInfo.ServerEphemeral
 * @returns {{ clientEphemeral: Uint8Array, clientProof: Uint8Array, expectedServerProof: Uint8Array }}
 */
export function generateProofs(byteLength, hashedPasswordBytes, modulusBytes, serverEphemeralBytes) {
  const generator = 2n;
  const modulus = bytesToBigInt(modulusBytes);
  const modulusMinusOne = modulus - 1n;
  const hashedPassword = bytesToBigInt(hashedPasswordBytes);
  const serverEphemeral = bytesToBigInt(serverEphemeralBytes);

  // Multiplier k = H(g || N)  where both are padded to byteLength, little-endian.
  const multiplier = mod(
    bytesToBigInt(expandHash(Buffer.concat([
      bigIntToBytes(generator, byteLength),
      modulusBytes,
    ]))),
    modulus,
  );

  // Validate parameters.
  if (multiplier <= 1n || multiplier >= modulusMinusOne)
    throw new Error('SRP multiplier out of bounds');
  if (serverEphemeral <= 1n || serverEphemeral >= modulusMinusOne)
    throw new Error('SRP server ephemeral out of bounds');

  // Generate client secret and ephemeral, retrying until scrambling param ≠ 0.
  let clientSecret, clientEphemeral, scramblingParam;
  while (true) {
    // Client secret must be > 2 * bitLength.
    do {
      const secretBytes = crypto.randomBytes(byteLength);
      clientSecret = bytesToBigInt(secretBytes);
    } while (clientSecret <= BigInt(byteLength * 2));

    clientEphemeral = modPow(generator, clientSecret, modulus);

    scramblingParam = bytesToBigInt(expandHash(Buffer.concat([
      bigIntToBytes(clientEphemeral, byteLength),
      Buffer.from(serverEphemeralBytes),
    ])));

    if (scramblingParam !== 0n) break;
  }

  // Shared session key:
  //   S = (B - k * g^x)^(a + u*x)  mod N
  const kgx = mod(modPow(generator, hashedPassword, modulus) * multiplier, modulus);
  let subtracted = mod(serverEphemeral - kgx, modulus);
  const exponent = mod(scramblingParam * hashedPassword + clientSecret, modulusMinusOne);
  const sharedSession = modPow(subtracted, exponent, modulus);

  // Proofs.
  const clientEphemeralBytes = bigIntToBytes(clientEphemeral, byteLength);
  const sharedSessionBytes   = bigIntToBytes(sharedSession, byteLength);

  const clientProof = expandHash(Buffer.concat([
    clientEphemeralBytes,
    Buffer.from(serverEphemeralBytes),
    sharedSessionBytes,
  ]));

  const expectedServerProof = expandHash(Buffer.concat([
    clientEphemeralBytes,
    clientProof,
    sharedSessionBytes,
  ]));

  return { clientEphemeral: clientEphemeralBytes, clientProof, expectedServerProof };
}
