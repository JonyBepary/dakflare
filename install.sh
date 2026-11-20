#!/bin/sh
# DakFlare installer.
#
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/dakflare/main/install.sh | sh
#
# Fetches the repository at a ref, keeps the checkout (the Worker and console
# live in it), and links the zero-dependency CLI into a bin directory. It does
# not provision anything and never touches Cloudflare; that is `dakflare up`.
#
# Options:
#   --ref REF        branch, tag or commit to install (default: main)
#   --dir DIR        where the checkout goes (default: ./dakflare)
#   --bin-dir DIR    where the `dakflare` command is linked (default: ~/.local/bin)
#   --cli-only       install only the CLI, not the Worker and console tree
#   --force          replace an existing --dir
#   -h, --help       this text
#
# Environment:
#   DAKFLARE_REPO      owner/repo, default JonyBepary/dakflare
#   DAKFLARE_REF       same as --ref
#   DAKFLARE_DIR       same as --dir
#   DAKFLARE_BIN_DIR   same as --bin-dir
#   DAKFLARE_TARBALL   a local .tar.gz or URL to install from, instead of GitHub

set -eu
umask 022

REPO="${DAKFLARE_REPO:-JonyBepary/dakflare}"
REF="${DAKFLARE_REF:-main}"
DIR="${DAKFLARE_DIR:-dakflare}"
BIN_DIR="${DAKFLARE_BIN_DIR:-$HOME/.local/bin}"
CLI_ONLY=0
FORCE=0

usage() {
	cat <<'EOF'
usage: install.sh [--ref REF] [--dir DIR] [--bin-dir DIR] [--cli-only] [--force]

  --ref REF        branch, tag or commit to install (default: main)
  --dir DIR        where the checkout goes (default: ./dakflare)
  --bin-dir DIR    where the `dakflare` command is linked (default: ~/.local/bin)
  --cli-only       install only the CLI, not the Worker and console tree
  --force          replace an existing --dir
  -h, --help       this text
EOF
}

die() {
	printf 'install: %s\n' "$1" >&2
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
	--ref)
		[ $# -ge 2 ] || die "--ref needs a value"
		REF="$2"
		shift 2
		;;
	--dir)
		[ $# -ge 2 ] || die "--dir needs a value"
		DIR="$2"
		shift 2
		;;
	--bin-dir)
		[ $# -ge 2 ] || die "--bin-dir needs a value"
		BIN_DIR="$2"
		shift 2
		;;
	--cli-only)
		CLI_ONLY=1
		shift
		;;
	--force)
		FORCE=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		die "unknown option: $1 (try --help)"
		;;
	esac
done

[ -n "$DIR" ] && [ "$DIR" != "/" ] || die "refusing to install into '$DIR'"

# The CLI is pure Node with no dependencies, but it uses fetch and modern
# syntax, so 22 is the floor the README states.
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required and was not found"
node -e 'const m = Number(process.versions.node.split(".")[0]); process.exit(m >= 22 ? 0 : 1)' ||
	die "Node.js 22+ is required (found $(node --version))"

if [ -e "$DIR" ] && [ "$FORCE" -ne 1 ]; then
	die "'$DIR' already exists. Pass --force to replace it, or --dir to choose another path."
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dakflare-install.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -qO "$2" "$1"
	else
		die "curl or wget is required"
	fi
}

if [ -n "${DAKFLARE_TARBALL:-}" ]; then
	case "$DAKFLARE_TARBALL" in
	http://* | https://*) fetch "$DAKFLARE_TARBALL" "$TMP/src.tar.gz" ;;
	*) [ -f "$DAKFLARE_TARBALL" ] || die "no such tarball: $DAKFLARE_TARBALL" ; cp "$DAKFLARE_TARBALL" "$TMP/src.tar.gz" ;;
	esac
else
	fetch "https://codeload.github.com/$REPO/tar.gz/$REF" "$TMP/src.tar.gz"
fi

tar -xzf "$TMP/src.tar.gz" -C "$TMP" || die "the download was not a readable tar.gz"

SRC=""
for entry in "$TMP"/*; do
	if [ -d "$entry" ]; then
		SRC="$entry"
		break
	fi
done
[ -n "$SRC" ] || die "the archive had no top-level directory"
[ -f "$SRC/cli/bin/dakflare.js" ] || die "the archive does not look like DakFlare: cli/bin/dakflare.js is missing"

# Only now, with the archive fetched and checked, is it safe to replace.
if [ -e "$DIR" ]; then
	rm -rf "$DIR"
fi

if [ "$CLI_ONLY" -eq 1 ]; then
	mkdir -p "$DIR"
	cp -R "$SRC/cli" "$DIR/cli"
else
	mkdir -p "$DIR"
	cp -R "$SRC/." "$DIR/"
fi

chmod +x "$DIR/cli/bin/dakflare.js"

DIR_ABS="$(cd "$DIR" && pwd)"
mkdir -p "$BIN_DIR"
ln -sfn "$DIR_ABS/cli/bin/dakflare.js" "$BIN_DIR/dakflare"

VERSION="$("$BIN_DIR/dakflare" --version 2>/dev/null)" || die "the CLI was linked but does not run"

printf 'DakFlare %s installed\n' "${VERSION#dakflare }"
printf '  command  %s\n' "$BIN_DIR/dakflare"
printf '  checkout %s\n' "$DIR_ABS"
if [ "$CLI_ONLY" -eq 1 ]; then
	printf '  note     CLI only: the Worker and console tree is not installed\n'
fi

case ":${PATH:-}:" in
*":$BIN_DIR:"*) ;;
*)
	printf '\n%s is not on PATH. Add it in this shell:\n' "$BIN_DIR"
	printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
	;;
esac

cat <<EOF

Next:
  cd $DIR
  cd worker && npm install && cd ..
  dakflare init --local
  cf auth login
  dakflare up --email you@example.com
EOF
