#!/bin/bash
# Store an extra Nostr identity's nsec in the kernel keyring for the signing daemon.
#
#   bash tools/nostr-signer/add-account-key.sh sjvg
#   bash tools/nostr-signer/add-account-key.sh sovereignty-by-design
#
# The nsec is read silently from the terminal and piped to `keyctl padd`, so it never
# appears on screen, in shell history, or in `ps`. Re-running for the same account replaces
# the key. The default account (jorgenclaw) stays in the existing `nsec` key — not handled here.
# Restart the daemon afterwards: systemctl --user restart nostr-signer
# (then restart nanoclaw so containers re-mount the new socket).
set -euo pipefail

ACCOUNT="${1:-}"
case "$ACCOUNT" in
  sjvg|sovereignty-by-design) ;;
  *) echo "Usage: $0 <sjvg|sovereignty-by-design>" >&2; exit 1 ;;
esac

read -rsp "Paste the nsec1... for $ACCOUNT (input hidden): " NSEC
echo
if [[ "$NSEC" != nsec1* ]]; then
  echo "That doesn't look like an nsec1... value — nothing stored." >&2
  exit 1
fi

printf '%s' "$NSEC" | keyctl padd user "nostr:$ACCOUNT" @u >/dev/null
unset NSEC
echo "Stored as nostr:$ACCOUNT. Now run: systemctl --user restart nostr-signer"
