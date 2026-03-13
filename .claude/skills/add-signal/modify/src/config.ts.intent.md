# Intent: add Signal config exports and phone-number trigger support

## 1. Config exports

Append two new exports to src/config.ts after the existing channel config exports:

- `SIGNAL_PHONE_NUMBER` — the phone number registered with signal-cli (e.g. "+15551234567")
- `SIGNAL_SOCKET_PATH` — path to the signal-cli daemon Unix socket inside the container
  (default: /run/signal-cli/socket — mount the host socket at this path)

Both read from environment variables first, then envConfig, then fall back to defaults.
No new imports required — `envConfig` is already available in scope.

## 2. Phone-number trigger detection

Modify `messageHasTrigger()` to also match when Signal users @mention the
assistant by phone number (e.g. `@+15102143647`) rather than by trigger word.
Signal group members using the native @mention picker produce `@<phone>` when
the contact is saved by number, which silently fails the existing
`TRIGGER_PATTERN` (`/^@TriggerWord\b/i`).

Add a phone-number check after the existing `TRIGGER_PATTERN.test()` call:

```typescript
if (SIGNAL_PHONE_NUMBER && /^@\+?\d/.test(trimmed)) {
  const digits = SIGNAL_PHONE_NUMBER.replace(/^\+/, '');
  if (trimmed.startsWith(`@+${digits}`) || trimmed.startsWith(`@${digits}`)) {
    return true;
  }
}
```

This must come after the `SIGNAL_PHONE_NUMBER` export (which is declared later
in the file), so place it inside `messageHasTrigger()` — not at module level.
