#!/usr/bin/env bash
# Install the operator-local DakFlare -> EdgePay worker sync timer.
#
# The timer runs as the current user and uses the existing `wrangler` OAuth
# session. Nothing is stored in GitHub; see deploy/systemd/.
set -euo pipefail

REPO="${DAKFLARE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/dakflare"

mkdir -p "$UNIT_DIR" "$STATE_DIR"

for unit in dakflare-edgepay-sync.service dakflare-edgepay-sync.timer; do
  sed "s|%h/Projects/dakflare|$REPO|g" "$REPO/deploy/systemd/$unit" >"$UNIT_DIR/$unit"
done

chmod +x "$REPO/scripts/sync-edgepay-worker.sh"

systemctl --user daemon-reload
systemctl --user enable --now dakflare-edgepay-sync.timer

cat <<EOF
Installed and started:

  $UNIT_DIR/dakflare-edgepay-sync.service
  $UNIT_DIR/dakflare-edgepay-sync.timer

Logs:
  journalctl --user -u dakflare-edgepay-sync.service -f
  tail -f $STATE_DIR/edgepay-worker.log

The timer fires five minutes after boot and every 15 minutes. It deploys only
when worker/src, worker/migrations, worker/package*.json or
worker/wrangler.edgepay.toml changed on origin/main, and records the commit
only after the deployed manifest route answers.

To keep the timer running while logged out:
  loginctl enable-linger $USER

First run now:
  systemctl --user start dakflare-edgepay-sync.service
EOF
