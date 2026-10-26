#!/bin/bash
# One click, no typing: watches the Mac clipboard while EJ clicks Stripe's copy button on
# the new restricted key, pipes it to the VPS's ~/scripts/set-artie-jar-key.sh (which tests it against
# Stripe and saves it to .env.production), then clears the clipboard.
# Nothing is echoed or logged. EJ runs it himself:
#   ~/code/coachartie2-v3/scripts/jar-key-from-clipboard.sh
set -euo pipefail

wait_for_new_clip() {
  local before="$1"
  until [ "$(pbpaste)" != "$before" ] && [ -n "$(pbpaste)" ]; do sleep 0.4; done
  pbpaste
}

echo "Stripe → the new 'coachartie-ejfvps-2026-10' restricted key is shown."
echo
echo "Click the COPY button next to the key…"
KEY_VAL=$(wait_for_new_clip "$(pbpaste)")
echo "got it. Testing + saving on the VPS…"
echo
printf '%s\n' "$KEY_VAL" | ssh vps /home/debian/scripts/set-artie-jar-key.sh 2>/dev/null
unset KEY_VAL
printf '' | pbcopy
echo
echo "(clipboard cleared)"
