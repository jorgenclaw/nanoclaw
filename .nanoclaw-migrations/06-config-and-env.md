# Config + .env additions

## src/config.ts (+98 / -3) — new exports

Apply at the top of the file:
```typescript
export const PROJECT_ROOT = process.cwd();           // was likely private
export const HOME_DIR = process.env.HOME || os.homedir();   // was likely private
```

Add 30+ new env-var-driven config exports. Group by subsystem:

### Signal channel
```typescript
export const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST = process.env.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(process.env.SIGNAL_CLI_TCP_PORT || '7583', 10);
export const SIGNAL_TRIGGER_WORD = process.env.SIGNAL_TRIGGER_WORD || '@Jorgenclaw';
```

### Watch channel
```typescript
export const WATCH_AUTH_TOKEN = process.env.WATCH_AUTH_TOKEN || '';
export const WATCH_HTTP_PORT = parseInt(process.env.WATCH_HTTP_PORT || '8090', 10);
export const WATCH_HTTP_HOST = process.env.WATCH_HTTP_HOST || '0.0.0.0';
export const WATCH_NOTIFY_MAX_QUEUE = parseInt(process.env.WATCH_NOTIFY_MAX_QUEUE || '50', 10);
export const WATCH_NOTIFY_TTL_MS = parseInt(process.env.WATCH_NOTIFY_TTL_MS || '3600000', 10);
export const WATCH_MIRROR_TO_SIGNAL = process.env.WATCH_MIRROR_TO_SIGNAL === 'true';
export const WATCH_AUDIO_TRANSCRIBE = process.env.WATCH_AUDIO_TRANSCRIBE !== 'false';
```

### WhiteNoise channel
```typescript
export const WHITENOISE_SOCKET = process.env.WHITENOISE_SOCKET || `${HOME_DIR}/.local/share/whitenoise-cli/release/wnd.sock`;
export const WHITENOISE_POLL_INTERVAL_MS = parseInt(process.env.WHITENOISE_POLL_INTERVAL_MS || '3000', 10);
export const WHITENOISE_PUBKEY = process.env.WHITENOISE_PUBKEY || '';
```

### Nostr DM channel
```typescript
export const NOSTR_RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://relay.primal.net').split(',');
export const NOSTR_SIGNER_SOCKET = process.env.NOSTR_SIGNER_SOCKET || `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`}/nostr-signer.sock`;
```

### MCP Server (paid Nostr)
```typescript
export const MCP_SERVER_ENABLED = process.env.MCP_SERVER_ENABLED === 'true';
export const MCP_SERVER_PORT = parseInt(process.env.MCP_SERVER_PORT || '3099', 10);
export const MCP_SERVER_BASE_URL = process.env.MCP_SERVER_BASE_URL || 'https://mcp.jorgenclaw.ai';
export const NWC_CONNECTION_STRING = process.env.NWC_CONNECTION_STRING || '';
export const NWC_SPENDING_CONNECTION_STRING = process.env.NWC_SPENDING_CONNECTION_STRING || '';
export const CLOUDFLARE_KV_API_TOKEN = process.env.CLOUDFLARE_KV_API_TOKEN || '';
export const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID || '';
export const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_LIMIT || '200', 10);
```

### Credential proxy
```typescript
export const CREDENTIAL_PROXY_PORT = parseInt(process.env.CREDENTIAL_PROXY_PORT || '3001', 10);
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
```

### Whisper transcription
```typescript
export const WHISPER_BIN = process.env.WHISPER_BIN ?? `${HOME_DIR}/.local/bin/whisper-cli`;
export const WHISPER_MODEL = process.env.WHISPER_MODEL || `${HOME_DIR}/.local/share/whisper/models/ggml-base.en.bin`;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
```

### Health monitor
```typescript
export const HEALTH_DEDUP_WINDOW_MS = parseInt(process.env.HEALTH_DEDUP_WINDOW_MS || '3600000', 10);
```

### Security policy
```typescript
export const SECURITY_POLICY_PATH = process.env.SECURITY_POLICY_PATH || `${HOME_DIR}/.config/nanoclaw/security-policy.json`;
```

## .env additions (preserved by data-dir rule but document for reference)

The `.env` file is preserved by the migration (data-dir rule). For sanity post-migration, verify these are set:

```bash
# Signal
SIGNAL_PHONE_NUMBER=+18102143598
SIGNAL_CLI_TCP_HOST=127.0.0.1
SIGNAL_CLI_TCP_PORT=7583
SIGNAL_TRIGGER_WORD=@Jorgenclaw

# Watch
WATCH_AUTH_TOKEN=<secret>
WATCH_HTTP_PORT=8090
WATCH_MIRROR_TO_SIGNAL=true

# WhiteNoise
WHITENOISE_PUBKEY=d0514175a31de1942812597ee4e3f478b183f7f35fb73ee66d8c9f57485544e4

# Nostr DM
NOSTR_RELAYS=wss://relay.damus.io,wss://relay.primal.net
# (signer socket auto-discovers via XDG_RUNTIME_DIR)

# MCP server (paid Nostr) — optional
MCP_SERVER_ENABLED=true
MCP_SERVER_PORT=3099
NWC_CONNECTION_STRING=nostr+walletconnect://...
NWC_SPENDING_CONNECTION_STRING=...
CLOUDFLARE_KV_API_TOKEN=<secret>
CLOUDFLARE_KV_NAMESPACE_ID=<id>

# Credential proxy
ANTHROPIC_BASE_URL=https://api.anthropic.com  # or http://127.0.0.1:11434/v1 for Ollama
ANTHROPIC_API_KEY=<key>      # or
CLAUDE_CODE_OAUTH_TOKEN=<token>

# Whisper
WHISPER_BIN=/home/jorgenclaw/.local/bin/whisper-cli
WHISPER_MODEL=/home/jorgenclaw/.local/share/whisper/models/ggml-base.en.bin
OPENAI_API_KEY=<fallback key>

# Misc tools
PROTON_BRIDGE_USERNAME=agent@jorgenclaw.ai
PROTON_BRIDGE_PASSWORD=<bridge password>
MOLTBOOK_API_KEY=moltbook_sk_...
GH_TOKEN=ghp_...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-west-1
REMOTION_AWS_BUCKET=remotionlambda-uswest1-wolpcfhxtb
REMOTION_SERVE_URL=https://remotionlambda-uswest1-wolpcfhxtb.s3.us-west-1.amazonaws.com/sites/jorgenclaw-main/index.html
UDIOAPI_PRO_KEY=sk-...
CF_CACHE_PURGE_TOKEN=<token>
```

## Verification post-cutover

```bash
cd ~/NanoClaw
node -e "
const cfg = require('./dist/config.js');
console.log('SIGNAL_PHONE_NUMBER:', cfg.SIGNAL_PHONE_NUMBER ? 'set' : 'MISSING');
console.log('WATCH_AUTH_TOKEN:', cfg.WATCH_AUTH_TOKEN ? 'set' : 'MISSING');
console.log('WHISPER_BIN:', cfg.WHISPER_BIN);
// ... etc.
"
```

Or simpler — start the service and check logs for `WARN: <var> not set` messages.
