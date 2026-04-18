import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'TZ',
  'SIGNAL_PHONE_NUMBER',
  'SIGNAL_CLI_TCP_HOST',
  'SIGNAL_CLI_TCP_PORT',
  'WATCH_AUTH_TOKEN',
  'WATCH_HTTP_PORT',
  'WATCH_HTTP_BIND',
  'WATCH_JID',
  'WATCH_GROUP_FOLDER',
  'WATCH_SYNC_TIMEOUT_MS',
  'WATCH_SIGNAL_MIRROR_JID',
  'WN_BINARY_PATH',
  'WN_SOCKET_PATH',
  'WN_ACCOUNT_PUBKEY',
  'NOSTR_SIGNER_SOCKET',
  'NOSTR_DM_RELAYS',
  'NOSTR_DM_ALLOWLIST',
  'CREDENTIAL_PROXY_PORT',
  'SECURITY_POLICY_PATH',
  'MCP_SERVER_ENABLED',
  'WHISPER_BIN',
  'WHISPER_MODEL',
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
export const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();

// --- Custom channel config ---

// Signal (TCP JSON-RPC to signal-cli daemon)
export const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST = process.env.SIGNAL_CLI_TCP_HOST || envConfig.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || envConfig.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);

// Watch (T-Watch S3 HTTP server)
export const WATCH_AUTH_TOKEN = process.env.WATCH_AUTH_TOKEN || envConfig.WATCH_AUTH_TOKEN || '';
export const WATCH_HTTP_PORT = parseInt(process.env.WATCH_HTTP_PORT || envConfig.WATCH_HTTP_PORT || '3000', 10);
export const WATCH_HTTP_BIND = process.env.WATCH_HTTP_BIND || envConfig.WATCH_HTTP_BIND || '0.0.0.0';
export const WATCH_JID = process.env.WATCH_JID || envConfig.WATCH_JID || 'watch:device';
export const WATCH_GROUP_FOLDER = process.env.WATCH_GROUP_FOLDER || envConfig.WATCH_GROUP_FOLDER || 'watch';
export const WATCH_SYNC_TIMEOUT_MS = parseInt(
  process.env.WATCH_SYNC_TIMEOUT_MS || envConfig.WATCH_SYNC_TIMEOUT_MS || '45000',
  10,
);
export const WATCH_SIGNAL_MIRROR_JID = process.env.WATCH_SIGNAL_MIRROR_JID || envConfig.WATCH_SIGNAL_MIRROR_JID || '';

// White Noise (Nostr/MLS encrypted messaging)
export const WN_BINARY_PATH =
  process.env.WN_BINARY_PATH || envConfig.WN_BINARY_PATH || path.join(HOME_DIR, '.local', 'bin', 'wn');
export const WN_SOCKET_PATH =
  process.env.WN_SOCKET_PATH ||
  envConfig.WN_SOCKET_PATH ||
  path.join(HOME_DIR, '.local', 'share', 'whitenoise-cli', 'release', 'wnd.sock');
export const WN_ACCOUNT_PUBKEY = process.env.WN_ACCOUNT_PUBKEY || envConfig.WN_ACCOUNT_PUBKEY || '';

// Nostr DM (NIP-17)
export const NOSTR_SIGNER_SOCKET =
  process.env.NOSTR_SIGNER_SOCKET || envConfig.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
export const NOSTR_DM_RELAYS = (
  process.env.NOSTR_DM_RELAYS ||
  envConfig.NOSTR_DM_RELAYS ||
  'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band'
).split(',');
export const NOSTR_DM_ALLOWLIST = new Set(
  (process.env.NOSTR_DM_ALLOWLIST || envConfig.NOSTR_DM_ALLOWLIST || '').split(',').filter(Boolean),
);

// MCP Server
export const MCP_SERVER_ENABLED = (process.env.MCP_SERVER_ENABLED || envConfig.MCP_SERVER_ENABLED) === 'true';

// Security Policy
export const SECURITY_POLICY_PATH =
  process.env.SECURITY_POLICY_PATH ||
  envConfig.SECURITY_POLICY_PATH ||
  path.join(HOME_DIR, '.config', 'nanoclaw', 'security-policy.json');

// Credential Proxy
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || envConfig.CREDENTIAL_PROXY_PORT || '3001',
  10,
);

// Local Whisper transcription
export const WHISPER_BIN =
  process.env.WHISPER_BIN ?? envConfig.WHISPER_BIN ?? path.join(HOME_DIR, '.local', 'bin', 'whisper-cli');
export const WHISPER_MODEL =
  process.env.WHISPER_MODEL ??
  envConfig.WHISPER_MODEL ??
  path.join(HOME_DIR, '.local', 'share', 'whisper', 'models', 'ggml-base.en.bin');
