#!/usr/bin/env bash
#
# Build the signed release APK for the handset and prove what came out.
#
#   simulator/scripts/release-apk.sh
#
# Signing material is never in the repository. It is read, in order, from the
# environment or from ~/.config/dakflare/release-keystore.txt:
#
#   DAKFLARE_KEYSTORE           ~/.config/dakflare/dakflare-release.jks
#   DAKFLARE_KEYSTORE_PASSWORD  (from the file when not exported)
#   DAKFLARE_KEY_ALIAS          dakflare
#
# The script refuses to run without the keystore; Gradle independently refuses a
# release build without it, so neither path can fall back to the debug key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SIM="$(cd "$HERE/.." && pwd)"
CONFIG_DIR="$HOME/.config/dakflare"
ENV_FILE="$CONFIG_DIR/android-env.sh"
SIGNING_FILE="$CONFIG_DIR/release-keystore.txt"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf 'release-apk: %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] && . "$ENV_FILE"

# Read one key from the private properties-style file without sourcing it: a
# stray line in a secret file must not become shell.
config_value() {
  [ -f "$SIGNING_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SIGNING_FILE" | head -1
}

DAKFLARE_KEYSTORE="${DAKFLARE_KEYSTORE:-$(config_value keystore)}"
DAKFLARE_KEYSTORE="${DAKFLARE_KEYSTORE:-$CONFIG_DIR/dakflare-release.jks}"
DAKFLARE_KEYSTORE_PASSWORD="${DAKFLARE_KEYSTORE_PASSWORD:-$(config_value storePassword)}"
DAKFLARE_KEY_ALIAS="${DAKFLARE_KEY_ALIAS:-$(config_value alias)}"
DAKFLARE_KEY_ALIAS="${DAKFLARE_KEY_ALIAS:-dakflare}"
DAKFLARE_KEY_PASSWORD="${DAKFLARE_KEY_PASSWORD:-$(config_value keyPassword)}"
DAKFLARE_KEY_PASSWORD="${DAKFLARE_KEY_PASSWORD:-$DAKFLARE_KEYSTORE_PASSWORD}"

if [ ! -f "$DAKFLARE_KEYSTORE" ]; then
  cat >&2 <<EOF
release-apk: release keystore not found: $DAKFLARE_KEYSTORE

Create it once and keep it safe (losing it means no in-place updates):

  mkdir -p "$CONFIG_DIR"
  keytool -genkeypair -keystore "$CONFIG_DIR/dakflare-release.jks" \\
    -storetype PKCS12 -alias dakflare -keyalg RSA -keysize 4096 \\
    -validity 10000 -dname "CN=DakFlare Release, O=DakFlare, C=BD"

Then write $SIGNING_FILE (mode 600) with alias=, storePassword=, keyPassword=.
See docs/PHONE_RELEASE.md.
EOF
  exit 1
fi

[ -n "${DAKFLARE_KEYSTORE_PASSWORD:-}" ] || die \
  "no signing password: set DAKFLARE_KEYSTORE_PASSWORD or add storePassword= to $SIGNING_FILE"
[ -n "${DAKFLARE_KEY_ALIAS:-}" ] || die "no signing alias: set DAKFLARE_KEY_ALIAS"

export DAKFLARE_KEYSTORE DAKFLARE_KEYSTORE_PASSWORD DAKFLARE_KEY_ALIAS DAKFLARE_KEY_PASSWORD

# Fail before the (long) Rust build if the password does not open this key.
if ! "${JAVA_HOME:-/usr}/bin/keytool" -list -keystore "$DAKFLARE_KEYSTORE" \
  -storepass "$DAKFLARE_KEYSTORE_PASSWORD" -alias "$DAKFLARE_KEY_ALIAS" >/dev/null 2>&1; then
  die "cannot open $DAKFLARE_KEYSTORE with alias $DAKFLARE_KEY_ALIAS; wrong password or alias"
fi

say "Signing key"
printf 'keystore: %s\nalias:    %s\n' "$DAKFLARE_KEYSTORE" "$DAKFLARE_KEY_ALIAS"
"${JAVA_HOME:-/usr}/bin/keytool" -list -v -keystore "$DAKFLARE_KEYSTORE" \
  -storepass "$DAKFLARE_KEYSTORE_PASSWORD" -alias "$DAKFLARE_KEY_ALIAS" \
  | grep -E "Owner:|Valid from:|SHA256:|Subject Public Key Algorithm:" | sed 's/^/  /'

BUILD_TOOLS="$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT2="$BUILD_TOOLS/aapt2"
[ -x "$APKSIGNER" ] || die "apksigner not found under $BUILD_TOOLS"

say "Release build (aarch64)"
cd "$SIM"
npx tauri android build --apk --target aarch64

APK="$(find "$SIM/src-tauri/gen/android/app/build/outputs/apk" \
  -path '*/release/*' -name '*.apk' ! -name '*unsigned*' -printf '%T@ %p\n' 2>/dev/null \
  | sort -n | tail -1 | cut -d' ' -f2-)"
[ -n "${APK:-}" ] || die "build finished but no APK was found under app/build/outputs/apk"
[ -f "$APK" ] || die "APK path does not exist: $APK"

say "APK"
printf 'path:  %s\n' "$APK"
printf 'size:  %s (%s bytes)\n' \
  "$(du -h "$APK" | cut -f1)" "$(stat -c '%s' "$APK")"
"$AAPT2" dump badging "$APK" | sed -n 's/^package: /package: /p' | head -1
printf 'sha256 (file): %s\n' "$(sha256sum "$APK" | cut -d' ' -f1)"

say "signature"
"$APKSIGNER" verify --verbose --print-certs "$APK"

say "version"
"$AAPT2" dump badging "$APK" \
  | grep -E "^package:|^sdkVersion:|^targetSdkVersion:|^uses-permission: name='android.permission.(RECEIVE_SMS|SEND_SMS|READ_PHONE_NUMBERS|READ_PHONE_STATE|POST_NOTIFICATIONS|FOREGROUND_SERVICE|FOREGROUND_SERVICE_REMOTE_MESSAGING|RECEIVE_BOOT_COMPLETED)'" \
  | sed 's/^/  /'

printf '\nInstall on the paired handset (a signature change requires uninstall, which deletes its data):\n'
printf '  adb install -r %q\n' "$APK"
