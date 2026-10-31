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
#   simulator/scripts/inject-sms.sh '+8801700000000' 'long body' --parts 3 --ucs2
#
# Exit codes: 0 delivered, 2 bad usage, 3 toolchain missing, 4 injector failed.
set -euo pipefail

SERIAL="${ANDROID_SERIAL:-100.110.66.88:5555}"
PARTS=1
FORCE_UCS2=0
ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --parts)
      [ "$#" -ge 2 ] || { echo "--parts needs a value" >&2; exit 2; }
      PARTS="$2"
      shift 2
      ;;
    --ucs2)
      FORCE_UCS2=1
      shift
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do ARGS+=("$1"); shift; done
      ;;
    --*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if [ "${#ARGS[@]}" -lt 2 ]; then
  sed -n '3,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

SENDER="${ARGS[0]}"
BODY="${ARGS[1]}"
SUB_ID="${ARGS[2]:-1}"

case "$PARTS" in
  ''|*[!0-9]*) echo "--parts must be a positive number" >&2; exit 2 ;;
esac
[ "$PARTS" -ge 1 ] || { echo "--parts must be at least 1" >&2; exit 2; }

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

PDU_ARGS=("$SENDER" "$BODY" --parts "$PARTS")
if [ "$FORCE_UCS2" -eq 1 ]; then
  PDU_ARGS+=(--ucs2)
fi
PDU="$(python3 "$HERE/sms-pdu.py" "${PDU_ARGS[@]}")"

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
  "CLASSPATH=$JAR_DEVICE app_process /system/bin SmsInject $PDU $SUB_ID" 2>&1 | grep -q "sent pdus=$PARTS"; then
  echo "injector did not confirm the broadcast (is the device rooted?)" >&2
  exit 4
fi

echo "delivered pdus=$PARTS -> $SENDER (sub $SUB_ID)"
