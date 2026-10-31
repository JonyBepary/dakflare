#!/usr/bin/env bash
#
# Verify the DakFlare phone the way the M5.2/M5.3 work was verified: one
# command, one line per check, exit non-zero if any check fails.
#
# The checks exercise the real paths, not mocks:
#   attached      adb sees the handset, the debug app is installed, version
#   role          android.app.role.SMS is held by dev.dakflare.simulator
#   key           simulator.db has no plaintext PKCS#8 key and a Keystore blob
#   receive       a real SMS_DELIVER PDU through inject-sms.sh -> exactly one row
#   provider      the same body reached content://sms/inbox with this app as creator
#   send          send_sms through the debug WebView -> row sent + content://sms/sent
#   notification  the inbound notification is posted with its "Reply" action
#   service       GatewayService is foreground; --reboot also proves the boot path
#
# Two numbers appear here on purpose: +8801540196080 is the operator's own
# second handset (the documented receive/send peer), and no credential is read
# or printed. The script never changes the SMS role or airplane mode.
#
#   simulator/scripts/device-check.sh
#   simulator/scripts/device-check.sh --reboot
#   ANDROID_SERIAL=192.168.0.112:5555 simulator/scripts/device-check.sh
#
# Requires: a rooted debug handset (inject-sms.sh runs app_process as uid 0),
# adb, node, python3, sqlite3, and the env file android-setup.sh wrote
# (sourced automatically when ANDROID_HOME is absent). The send check
# needs a debug build: its WebView must expose webview_devtools_remote_<pid>.
#
# Exit: 0 every runnable check passed (a SKIP is not a pass), 1 any FAIL,
# 2 usage/missing tool.
set -uo pipefail

PKG=dev.dakflare.simulator
ACT="$PKG/.MainActivity"
SERIAL="${ANDROID_SERIAL:-100.110.66.88:5555}"
ADB="${ADB:-adb}"
# The operator's own second handset; both legs of the test use it so a flow
# reply cannot text a stranger.
CHECK_PEER="${CHECK_PEER:-+8801540196080}"
SEND_TO="${SEND_TO:-+8801540196080}"
CDP_PORT="${CDP_PORT:-9339}"
SUB_ID="${SUB_ID:-1}"
DO_REBOOT=0

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=""
PASSED=0
FAILED=0
SKIPPED=0
RECEIVED_TOKEN=""

usage() {
  cat <<EOF
Usage: device-check.sh [--reboot]

Runs eight checks against ANDROID_SERIAL (default 100.110.66.88:5555) and
prints what each one actually saw.

Checks:
  attached      device present, $PKG installed, its versionName
  role          android.app.role.SMS is $PKG (reports the real holder when not)
  key           the pulled simulator.db has 0 "BEGIN PRIVATE KEY" and >=1 "keystore:v1:"
  receive       inject one PDU, wait for the inbound log, require exactly one new row
  provider      the same body is in content://sms/inbox, creator=$PKG
  send          send_sms through the debug WebView to $SEND_TO; require state sent
                and a content://sms/sent row. A radio refusal is SKIP, never PASS.
  notification  the inbound notification is posted with its "Reply" action
  service       GatewayService is foreground; with --reboot, it also returns
                after a reboot without the app being opened

Destructive flag:
  --reboot      reboot the handset and check the boot path. adb drops and the
                script waits for sys.boot_completed=1; the app is not opened.

Other flags:
  -h, --help    this text

Environment:
  ANDROID_SERIAL   serial to use (default 100.110.66.88:5555)
  CHECK_PEER       receive sender (default +8801540196080)
  SEND_TO          send recipient (default +8801540196080)
  CDP_PORT         local port for the WebView devtools forward (default 9339)
  ADB              adb binary (default: adb on PATH)
  SUB_ID           SIM subscription id for the injector (default 1)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --reboot) DO_REBOOT=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# android-setup.sh writes the toolchain here; inject-sms.sh needs JAVA_HOME and
# ANDROID_HOME, so source it rather than making every caller do it.
if [ -z "${ANDROID_HOME:-}" ] && [ -f "$HOME/.config/dakflare/android-env.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.config/dakflare/android-env.sh"
fi
export ANDROID_SERIAL="$SERIAL"

for tool in "$ADB" node python3 sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing required tool: $tool" >&2
    exit 2
  }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dakflare-device-check.XXXXXX")" || {
  echo "cannot create a temporary directory" >&2
  exit 2
}

cleanup() {
  "$ADB" -s "$SERIAL" forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

d() { "$ADB" -s "$SERIAL" "$@"; }

pass() { printf '[PASS] %-12s %s\n' "$1" "$2"; PASSED=$((PASSED + 1)); }
fail() { printf '[FAIL] %-12s %s\n' "$1" "$2"; FAILED=$((FAILED + 1)); }
skip() { printf '[SKIP] %-12s %s\n' "$1" "$2"; SKIPPED=$((SKIPPED + 1)); }
detail() { printf '       %-12s %s\n' "$1" "$2"; }

# Pull a consistent copy of the app database. No WAL is used, so a plain copy
# is complete; quick_check catches a copy caught mid-write.
pull_db() {
  local attempt
  : > "$WORK/pull.err"
  for attempt in 1 2 3; do
    if d exec-out run-as "$PKG" cat simulator.db > "$WORK/simulator.db" 2>"$WORK/pull.err" \
      && [ -s "$WORK/simulator.db" ] \
      && sqlite3 -batch "$WORK/simulator.db" 'pragma quick_check;' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

db() { sqlite3 -batch -noheader "$WORK/simulator.db" "$1" 2>/dev/null; }

check_attached() {
  local state model path version code

  if ! state="$(d get-state 2>&1)"; then
    fail attached "no device at $SERIAL: $(printf '%s' "$state" | tr -d '\r' | head -1)"
    return 1
  fi
  state="$(printf '%s' "$state" | tr -d '\r')"
  if [ "$state" != "device" ]; then
    fail attached "$SERIAL is '$state', not 'device'"
    return 1
  fi

  model="$(d shell getprop ro.product.model | tr -d '\r')"
  path="$(d shell pm path "$PKG" | tr -d '\r' | head -1)"
  if [ -z "$path" ]; then
    fail attached "$SERIAL ($model) is online, but $PKG is not installed"
    return 1
  fi

  version="$(d shell dumpsys package "$PKG" | tr -d '\r' | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -1)"
  code="$(d shell dumpsys package "$PKG" | tr -d '\r' | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)"
  pass attached "$SERIAL ($model): $PKG versionName=${version:-<unknown>} versionCode=${code:-<unknown>}"
  return 0
}

check_role() {
  local holders actual

  if ! holders="$(d shell cmd role get-role-holders android.app.role.SMS 2>&1)"; then
    fail role "cmd role failed: $(printf '%s' "$holders" | tr -d '\r' | head -1)"
    return
  fi
  holders="$(printf '%s' "$holders" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d')"
  actual="$(printf '%s' "$holders" | tr '\n' ',' | sed 's/,$//')"
  actual="${actual:-<none>}"

  if printf '%s\n' "$holders" | grep -Fxq "$PKG"; then
    pass role "android.app.role.SMS -> $actual"
  else
    fail role "android.app.role.SMS -> $actual (expected $PKG)"
  fi
}

check_key() {
  local priv keys

  if ! pull_db; then
    fail key "cannot pull simulator.db with run-as: $(tr -d '\r' < "$WORK/pull.err" | tail -1)"
    return
  fi
  if ! head -c 16 "$WORK/simulator.db" 2>/dev/null | grep -q 'SQLite format 3'; then
    fail key "pulled simulator.db is not a SQLite database"
    return
  fi

  priv="$(grep -a -c 'BEGIN PRIVATE KEY' "$WORK/simulator.db" || true)"
  keys="$(grep -a -o 'keystore:v1:' "$WORK/simulator.db" | wc -l | tr -d ' ')"
  if [ "${priv:-0}" = "0" ] && [ "${keys:-0}" -ge 1 ]; then
    pass key "simulator.db: 0 'BEGIN PRIVATE KEY', $keys 'keystore:v1:'"
  else
    fail key "simulator.db: $priv 'BEGIN PRIVATE KEY' (expected 0), $keys 'keystore:v1:' (expected >=1)"
  fi
}

check_receive() {
  local token total_before in_before total_after in_after row_count row_peer line

  token="DAKFLARE-DEVICE-CHECK-$(date +%s)-$$"
  RECEIVED_TOKEN="$token"

  if ! pull_db; then
    fail receive "cannot read simulator.db before injection: $(tr -d '\r' < "$WORK/pull.err" | tail -1)"
    return
  fi
  total_before="$(db 'select count(*) from messages;')"
  in_before="$(db "select count(*) from messages where direction='in';")"

  d logcat -c >/dev/null 2>&1 || true
  # A visible thread suppresses its own notification, so leave the app before
  # injecting. HOME does not change the role or the radio.
  d shell input keyevent KEYCODE_HOME >/dev/null 2>&1 || true
  sleep 1

  if ! ANDROID_SERIAL="$SERIAL" "$HERE/inject-sms.sh" "$CHECK_PEER" "$token" "$SUB_ID" \
    > "$WORK/inject.log" 2>&1; then
    fail receive "inject-sms.sh failed: $(tail -1 "$WORK/inject.log")"
    return
  fi

  line=""
  for _ in $(seq 1 40); do
    line="$(d logcat -d -s DakFlareSms:I 2>/dev/null | tr -d '\r' | grep -E 'inbound sender=.*stored=true' | tail -1)"
    [ -n "$line" ] && break
    sleep 0.5
  done

  row_count=0
  row_peer=""
  for _ in $(seq 1 20); do
    pull_db >/dev/null 2>&1 || true
    row_count="$(db "select count(*) from messages where direction='in' and body='$token';")"
    row_count="${row_count:-0}"
    [ "$row_count" = "1" ] && break
    sleep 0.5
  done

  pull_db >/dev/null 2>&1 || true
  total_after="$(db 'select count(*) from messages;')"
  in_after="$(db "select count(*) from messages where direction='in';")"
  row_peer="$(db "select peer from messages where direction='in' and body='$token' limit 1;")"

  if [ -z "$line" ]; then
    fail receive "no 'inbound sender=... stored=true' log line within 20s (rows ${total_before:-?}->${total_after:-?}, body=$token)"
    return
  fi
  if [ "${row_count:-0}" = "0" ]; then
    fail receive "no inbound row for body=$token after 10s (rows ${total_before:-?}->${total_after:-?}); log: $line"
    return
  fi
  if [ "${row_count:-0}" != "1" ]; then
    fail receive "$row_count inbound rows for body=$token (expected exactly 1); log: $line"
    return
  fi
  if [ "$row_peer" != "$CHECK_PEER" ]; then
    fail receive "inbound row peer=$row_peer, expected $CHECK_PEER; log: $line"
    return
  fi

  pass receive "injected from $CHECK_PEER: exactly 1 inbound row, body=$token"
  detail receive "log: $line"
  detail receive "total rows ${total_before:-?}->${total_after:-?}, inbound ${in_before:-?}->${in_after:-?}"
}

check_provider() {
  local token rows count

  token="$RECEIVED_TOKEN"
  if [ -z "$token" ]; then
    fail provider "no received token to look up"
    return
  fi

  rows="$(d shell "content query --uri content://sms/inbox --projection _id:address:body:creator --where \"body='$token'\"" 2>/dev/null | tr -d '\r')"
  count="$(printf '%s\n' "$rows" | grep -c '^Row:')"
  count="${count:-0}"

  if [ "$count" = "1" ] && printf '%s\n' "$rows" | grep -q "creator=$PKG"; then
    pass provider "content://sms/inbox: $(printf '%s' "$rows" | head -1)"
  elif [ "$count" = "0" ]; then
    fail provider "content://sms/inbox has no row for body=$token (reply: ${rows:-<empty>})"
  else
    fail provider "content://sms/inbox has $count rows for body=$token (expected 1): $(printf '%s' "$rows" | head -3 | tr '\n' ';')"
  fi
}

start_debug_webview() {
  local pid last="" stable=0

  d shell am start -W -n "$ACT" >/dev/null 2>&1 || return 1
  # A background process can be replaced just after the Activity starts. Wait
  # for the same pid to own a devtools socket on two consecutive reads before
  # forwarding, or a forward can point at a socket that is already closing.
  for _ in $(seq 1 60); do
    pid="$(d shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
    if [ -n "$pid" ] && [ "$pid" = "$last" ] \
      && d shell cat /proc/net/unix 2>/dev/null | grep -q "@webview_devtools_remote_$pid"; then
      stable=$((stable + 1))
    else
      stable=0
    fi
    last="$pid"
    if [ "$stable" -ge 2 ]; then
      printf '%s' "$pid"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

check_send() {
  local token pid out rc parsed
  local s_state s_local s_error s_last s_did s_to
  local rows count attempt probe bridge

  token="DAKFLARE-DEVICE-CHECK-SEND-$(date +%s)-$$"

  bridge=0
  for attempt in 1 2 3; do
    if ! pid="$(start_debug_webview)"; then
      continue
    fi
    d forward --remove "tcp:$CDP_PORT" >/dev/null 2>&1 || true
    if ! d forward "tcp:$CDP_PORT" "localabstract:webview_devtools_remote_$pid" >/dev/null 2>&1; then
      continue
    fi
    sleep 1
    # Prove the forwarded socket is the app page before spending a real send
    # on it; a stale forward is the failure mode this wait removes.
    if probe="$(timeout 20 node "$HERE/cdp-invoke.mjs" --port "$CDP_PORT" \
      --expression 'location.href' --timeout 15000 2>/dev/null)" \
      && printf '%s' "$probe" | grep -q 'tauri.localhost'; then
      bridge=1
      break
    fi
    sleep 1
  done
  if [ "$bridge" -ne 1 ]; then
    fail send "debug WebView did not answer CDP on tcp:$CDP_PORT (last page: ${probe:-<none>}); cannot invoke send_sms"
    return
  fi

  cat > "$WORK/send-expr.js" <<EOF
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 50 && !window.__TAURI_INTERNALS__; i += 1) await sleep(200);
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { error: 'window.__TAURI_INTERNALS__.invoke is unavailable' };
  }
  const invoke = internals.invoke;
  const devices = await invoke('list_devices');
  const deviceId = devices && devices.length ? devices[0].device_id : '';
  if (!deviceId) return { error: 'list_devices returned no device' };
  const to = '$SEND_TO';
  const body = '$token';
  let sent = null;
  let error = '';
  try {
    sent = await invoke('send_sms', { deviceId, to, body });
  } catch (e) {
    error = String(e);
  }
  if (!sent || !sent.local_id) {
    return { deviceId, to, body, localId: '', state: '', lastError: '', error: error || 'send_sms returned no local_id' };
  }
  let row = null;
  for (let i = 0; i < 45; i += 1) {
    const rows = await invoke('list_messages', { deviceId, limit: 50 });
    row = rows.find((r) => r.local_id === sent.local_id) || null;
    if (row && (row.state === 'sent' || row.state === 'delivered' || row.state === 'failed')) break;
    await sleep(1000);
  }
  return {
    deviceId,
    to,
    body,
    localId: sent.local_id,
    state: row ? row.state : '',
    lastError: row && row.last_error ? row.last_error : '',
    error,
  };
})()
EOF

  out="$(timeout 120 node "$HERE/cdp-invoke.mjs" --port "$CDP_PORT" --file "$WORK/send-expr.js" --timeout 110000 2>"$WORK/cdp.err")"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail send "CDP invoke failed (exit $rc): $(tail -2 "$WORK/cdp.err" | tr '\n' ' ')"
    return
  fi

  printf '%s' "$out" > "$WORK/send.json"
  if ! parsed="$(python3 - "$WORK/send.json" <<'PY'
import json
import sys
try:
    value = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception as error:
    print(f'cannot parse CDP result: {error}')
    raise SystemExit(1)
fields = ('state', 'localId', 'error', 'lastError', 'deviceId', 'to')
print('\x1f'.join(str(value.get(key) or '') for key in fields))
PY
  )"; then
    fail send "cannot parse CDP result: $(tail -1 "$WORK/send.json")"
    return
  fi
  IFS=$'\x1f' read -r s_state s_local s_error s_last s_did s_to <<< "$parsed"

  if [ -z "$s_local" ]; then
    skip send "send_sms refused: ${s_error:-<no error text>} (no row was queued)"
    return
  fi

  if [ "$s_state" = "failed" ]; then
    rows="$(d shell "content query --uri content://sms/sent --projection _id:address:body:creator --where \"body='$token'\"" 2>/dev/null | tr -d '\r')"
    count="$(printf '%s\n' "$rows" | grep -c '^Row:')"
    count="${count:-0}"
    if [ "$count" != "0" ]; then
      fail send "row state=failed but content://sms/sent has $count rows for body=$token; a rejected send must not reach Sent"
    else
      skip send "radio refused: state=failed last_error=${s_last:-<none>}; content://sms/sent rows=0; local_id=$s_local"
    fi
    return
  fi

  if [ "$s_state" != "sent" ] && [ "$s_state" != "delivered" ]; then
    fail send "row local_id=$s_local stayed '${s_state:-missing}' (expected sent); device=$s_did to=$s_to"
    return
  fi

  rows=""
  count=0
  for _ in $(seq 1 20); do
    rows="$(d shell "content query --uri content://sms/sent --projection _id:address:body:creator --where \"body='$token'\"" 2>/dev/null | tr -d '\r')"
    count="$(printf '%s\n' "$rows" | grep -c '^Row:')"
    count="${count:-0}"
    [ "$count" = "1" ] && break
    sleep 0.5
  done

  if [ "$count" = "1" ] && printf '%s\n' "$rows" | grep -q "creator=$PKG"; then
    pass send "send_sms local_id=$s_local state=$s_state to=$s_to; content://sms/sent: $(printf '%s' "$rows" | head -1)"
  else
    fail send "row state=$s_state but content://sms/sent has $count rows for body=$token (expected 1); local_id=$s_local"
  fi
}

check_notification() {
  local token dump out rc suppressed

  token="$RECEIVED_TOKEN"
  dump="$WORK/notif.txt"
  if [ -z "$token" ]; then
    fail notification "no received token to look up"
    return
  fi

  for _ in $(seq 1 20); do
    d shell dumpsys notification --noredact > "$dump" 2>/dev/null || true
    if grep -q "android.text=String ($token)" "$dump" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done

  out="$(python3 - "$dump" "$CHECK_PEER" "$token" <<'PY'
import re
import sys

path, peer, body = sys.argv[1:4]
try:
    text = open(path, encoding='utf-8', errors='replace').read()
except OSError as error:
    print(f'cannot read dumpsys notification: {error}')
    raise SystemExit(1)

seen = 0
for block in re.split(r'(?=\n    NotificationRecord\()', text):
    if 'pkg=dev.dakflare.simulator' not in block:
        continue
    match = re.search(
        r'NotificationRecord\([^\n]*?\bid=(-?\d+) tag=dakflare-message(?!-)[^\n]*',
        block,
    )
    if not match:
        continue
    seen += 1
    if f'android.title=String ({peer})' not in block:
        continue
    if (
        f'android.text=String ({body})' not in block
        and f'android.bigText=String ({body})' not in block
    ):
        continue
    action = re.search(r'\[0\] "Reply" -> (PendingIntent\{[^\n]*)', block)
    if not action:
        print(f'id={match.group(1)} matches peer/body but has no "Reply" action')
        raise SystemExit(2)
    target = 'broadcast' if 'broadcastIntent' in action.group(1) else 'non-broadcast'
    print(f'id={match.group(1)} title={peer} text={body} replyAction={target}')
    raise SystemExit(0)

print(f'no dakflare-message notification for title={peer} body={body} ({seen} message notifications seen)')
raise SystemExit(1)
PY
)"
  rc=$?

  if [ "$rc" -eq 0 ]; then
    pass notification "$out"
    return
  fi

  suppressed="$(d logcat -d -s DakFlareSms:I 2>/dev/null | tr -d '\r' | grep -m1 -E 'notification suppressed|notification skipped|notification failed' || true)"
  fail notification "${out:-no matching notification}${suppressed:+; log: $suppressed}"
}

service_block() {
  d shell dumpsys activity services "$PKG" 2>/dev/null | tr -d '\r' | awk '
    /ServiceRecord.*GatewayService/ { inside = 1 }
    inside && /ServiceRecord/ && !/GatewayService/ { inside = 0 }
    inside { print }
  '
}

check_service() {
  local block fg

  block="$(service_block)"
  if ! printf '%s\n' "$block" | grep -q 'GatewayService'; then
    fail service "GatewayService is not running for $PKG"
    return
  fi
  fg="$(printf '%s\n' "$block" | grep -m1 'isForeground=' | sed 's/^ *//')"
  if printf '%s' "$fg" | grep -q 'isForeground=true'; then
    pass service "GatewayService $fg"
  else
    fail service "GatewayService ${fg:-has no isForeground line} (expected isForeground=true)"
  fi
}

check_reboot() {
  local boot top pid fg log

  echo "       reboot       rebooting $SERIAL; adb will drop and the app will not be opened"
  if ! d reboot; then
    fail reboot "adb reboot failed"
    return
  fi

  boot=""
  for _ in $(seq 1 180); do
    # A wireless adb link usually returns by itself; nudge it if it does not.
    if [ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null || true)" != "device" ] \
      && [[ "$SERIAL" == *:* ]]; then
      "$ADB" connect "$SERIAL" >/dev/null 2>&1 || true
    fi
    boot="$(d shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
    [ "$boot" = "1" ] && break
    sleep 2
  done
  if [ "$boot" != "1" ]; then
    fail reboot "device did not finish booting (sys.boot_completed=${boot:-<none>}) within 6 minutes"
    return
  fi

  # Wait for BootReceiver -> GatewayService. This loop only reads dumpsys; no
  # `am start` is issued after the reboot.
  fg=""
  for _ in $(seq 1 60); do
    fg="$(service_block | grep -m1 'isForeground=' | sed 's/^ *//')"
    if printf '%s' "$fg" | grep -q 'isForeground=true'; then
      break
    fi
    sleep 2
  done

  pid="$(d shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')"
  top="$(d shell dumpsys activity activities 2>/dev/null | tr -d '\r' | grep -m1 'topResumedActivity' | sed 's/^ *//')"
  log="$(d logcat -d -s DakFlareSms:I 2>/dev/null | tr -d '\r' | grep -m1 -E 'boot: gateway start requested|gateway started' || true)"

  if [ -z "$pid" ]; then
    fail reboot "after reboot $PKG has no process (BootReceiver did not start it)"
    return
  fi
  if printf '%s' "$top" | grep -q "$PKG"; then
    fail reboot "after reboot the app is foreground ($top); boot path not proven without opening it"
    return
  fi
  if printf '%s' "$fg" | grep -q 'isForeground=true'; then
    pass reboot "after reboot: GatewayService $fg; process=$pid; ${top#*topResumedActivity=}${log:+; log: $log}"
  else
    fail reboot "after reboot: GatewayService ${fg:-not running/foreground}; process=$pid; $top"
  fi
}

echo "device-check $SERIAL (peer $CHECK_PEER, send $SEND_TO)"

if check_attached; then
  check_role
  check_key
  check_receive
  check_provider
  # The notification check must run before the send check opens the app: a
  # visible thread suppresses its own notification by design, and the send check
  # leaves exactly that thread on screen.
  check_notification
  check_send
  check_service
  if [ "$DO_REBOOT" -eq 1 ]; then
    check_reboot
  fi
else
  for name in role key receive provider send notification service; do
    fail "$name" "not run: no usable device/app at $SERIAL"
  done
fi

echo
printf 'device-check: %d pass, %d fail, %d skip\n' "$PASSED" "$FAILED" "$SKIPPED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
