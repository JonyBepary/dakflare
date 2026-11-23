#!/usr/bin/env bash
# Install the operator-local DakFlare update CHECK timer (never auto-deploys).
#
# The timer runs as the current user and uses the existing `wrangler` OAuth
# session. Nothing is stored in GitHub; see deploy/systemd/.
set -euo pipefail

REPO="${DAKFLARE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dakflare"

mkdir -p "$UNIT_DIR" "$STATE_DIR"

for unit in dakflare-edgepay-check.service dakflare-edgepay-check.timer; do
  sed "s|%h/Projects/dakflare|$REPO|g" "$REPO/deploy/systemd/$unit" >"$UNIT_DIR/$unit"
done

chmod +x "$REPO/scripts/sync-edgepay-worker.sh"

systemctl --user daemon-reload
# Remove the old auto-deploy unit if it is still installed.
systemctl --user disable --now dakflare-edgepay-sync.timer 2>/dev/null || true
rm -f "$UNIT_DIR/dakflare-edgepay-sync.service" "$UNIT_DIR/dakflare-edgepay-sync.timer"
systemctl --user enable --now dakflare-edgepay-check.timer

cat <<EOF
Installed and started:

  $UNIT_DIR/dakflare-edgepay-check.service
  $UNIT_DIR/dakflare-edgepay-check.timer

Logs:
  journalctl --user -u dakflare-edgepay-check.service -f
  tail -f $STATE_DIR/edgepay-worker.log

The timer runs daily at 09:00 and only CHECKS. Nothing is deployed without
`edgepay dakflare worker update`, which requires a green Conformance Pipeline
run and a 24-hour soak. The check only reports candidate commits that touch
worker/src, worker/migrations, worker/package*.json or
worker/wrangler.edgepay.toml.

To keep the timer running while logged out:
  loginctl enable-linger $USER

First run now:
  systemctl --user start dakflare-edgepay-check.service
EOF
