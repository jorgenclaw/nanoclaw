# Intent: src/config.ts modifications

## What changed
Added three new configuration exports for Marmot / White Noise channel support.

## Key sections
- **readEnvFile call**: Must include `MARMOT_NOSTR_PRIVATE_KEY`, `MARMOT_NOSTR_RELAYS`, and `MARMOT_POLL_INTERVAL_MS` in the keys array. NanoClaw does NOT load `.env` into `process.env` — all `.env` values must be explicitly requested via `readEnvFile()`.
- **MARMOT_NOSTR_PRIVATE_KEY**: Nostr secret key in hex format. Read from `process.env` first, then `envConfig` fallback, defaults to empty string (channel disabled when empty).
- **MARMOT_NOSTR_RELAYS**: Comma-separated list of Nostr relay WebSocket URLs. Parsed into a `string[]` array. Defaults to empty array (channel disabled when empty).
- **MARMOT_POLL_INTERVAL_MS**: Polling interval for welcome messages (group invitations). Integer in milliseconds, defaults to 5000 (5 seconds).

## Invariants
- All existing config exports remain unchanged
- New Marmot keys are added to the `readEnvFile` call alongside existing keys
- New exports are appended at the end of the file
- No existing behavior is modified — Marmot config is additive only
- Both `process.env` and `envConfig` are checked (same pattern as `ASSISTANT_NAME`)
- `MARMOT_NOSTR_RELAYS` is split on commas and trimmed, producing a `string[]`

## Must-keep
- All existing exports (`ASSISTANT_NAME`, `POLL_INTERVAL`, `TRIGGER_PATTERN`, etc.)
- The `readEnvFile` pattern — ALL config read from `.env` must go through this function
- The `escapeRegex` helper and `TRIGGER_PATTERN` construction
