#!/usr/bin/env bash
#
# Deliver a real SMS_RECEIVED broadcast to the installed device app, as a test.
#
# The PDU is a 3GPP SMS-DELIVER built by sms-pdu.py; the injector runs under
# `app_process` as uid 0, which holds BROADCAST_SMS, so the app's manifest
# receiver sees the same intent a carrier delivery produces — same PDU parse,
# same multipart concat, same `subscription` extra. Nothing here fakes the
# receive path inside the app.
#
# The reply leg is real: `SmsManager` hands the reply to the radio. Only inject
# from a number you own, or the phone will text a stranger.
#
# Requires: a rooted device (adb root/su), the debug app installed, and the
# env file written by android-setup.sh sourced.
#
#   source ~/.config/dakflare/android-env.sh
#   simulator/scripts/inject-sms.sh '+8801700000000' 'DAKFLARE-GATE-1 hello'
#   simulator/scripts/inject-sms.sh bKash 'Your OTP is 1234'        # mask
#   simulator/scripts/inject-sms.sh 16222 'balance'                 # shortcode
#
# Exit codes: 0 delivered, 2 bad usage, 3 toolchain missing, 4 injector failed.
set -euo pipefail

SENDER="${1:-}"
BODY="${2:-}"
SUB_ID="${3:-1}"
SERIAL="${ANDROID_SERIAL:-100.110.66.88:5555}"

if [ -z "$SENDER" ] || [ -z "$BODY" ]; then
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
JAR_HOST="${TMPDIR:-/tmp}/dakflare-smsinject.jar"
JAR_DEVICE=/data/local/tmp/smsinject.jar

: "${ANDROID_HOME:?source the env file android-setup.sh wrote}"
: "${JAVA_HOME:?source the env file android-setup.sh wrote}"
ANDROID_JAR="$ANDROID_HOME/platforms/android-37.0/android.jar"
D8="$ANDROID_HOME/build-tools/37.0.0/d8"
for tool in "$ANDROID_JAR" "$D8" "$JAVA_HOME/bin/javac"; do
  [ -e "$tool" ] || { echo "missing $tool" >&2; exit 3; }
done

PDU="$(python3 "$HERE/sms-pdu.py" "$SENDER" "$BODY")"

build_jar() {
  local work
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN
  "$JAVA_HOME/bin/javac" -source 8 -target 8 -nowarn \
    -classpath "$ANDROID_JAR" -d "$work/classes" "$HERE/android/SmsInject.java" >/dev/null
  "$D8" --lib "$ANDROID_JAR" --min-api 24 --output "$work" \
    "$work/classes/SmsInject.class" >/dev/null
  ( cd "$work" && jar cf "$JAR_HOST" classes.dex )
}

# The jar is a build product of one small class; rebuild when it is absent or
# older than its source.
if [ ! -f "$JAR_HOST" ] || [ "$HERE/android/SmsInject.java" -nt "$JAR_HOST" ]; then
  build_jar
fi

adb -s "$SERIAL" push "$JAR_HOST" "$JAR_DEVICE" >/dev/null
if ! adb -s "$SERIAL" shell su -c \
  "CLASSPATH=$JAR_DEVICE app_process /system/bin SmsInject $PDU $SUB_ID" 2>&1 | grep -q 'sent pdus=1'; then
  echo "injector did not confirm the broadcast (is the device rooted?)" >&2
  exit 4
fi

echo "delivered pdu -> $SENDER (sub $SUB_ID)"
