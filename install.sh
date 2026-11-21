#!/bin/sh
# DakFlare installer.
#
#   curl -fsSL https://raw.githubusercontent.com/JonyBepary/dakflare/main/install.sh | sh
#
# Installs the prebuilt CLI binary and Worker pack by default, verifies their
# SHA-256, and starts `dakflare setup` on an interactive terminal. If a platform
# has no binary it falls back to the source checkout. `--source` forces the
# checkout, which is what contributors and source debugging use.
#
# Options:
#   --ref REF        branch, tag or commit to install (default: main)
#   --dir DIR        where the checkout goes (default: ./dakflare)
#   --bin-dir DIR    where the `dakflare` command is linked (default: ~/.local/bin)
#   --source         install the source checkout instead of the prebuilt binary
#   --binary         prebuilt CLI binary (default; falls back to source)
#   --cli-only       install only the CLI, not the Worker and console tree
#   --no-pack        do not download the precompiled Worker pack
#   --no-setup       install the files, but do not start the setup wizard
#   --force          replace an existing --dir
#   -h, --help       this text
#
# Environment:
#   DAKFLARE_REPO      owner/repo, default JonyBepary/dakflare
#   DAKFLARE_REF       same as --ref
#   DAKFLARE_DIR       same as --dir
#   DAKFLARE_BIN_DIR   same as --bin-dir
#   DAKFLARE_TARBALL   a local .tar.gz or URL to install from, instead of GitHub
#   DAKFLARE_NO_SETUP  same as --no-setup
#   DAKFLARE_PACK_URL  pack tarball URL (default: latest release asset)
#   DAKFLARE_PACK_DIR  where the pack is unpacked (default: ~/.local/share/dakflare/pack)

set -eu
umask 022

REPO="${DAKFLARE_REPO:-JonyBepary/dakflare}"
REF="${DAKFLARE_REF:-main}"
DIR="${DAKFLARE_DIR:-dakflare}"
BIN_DIR="${DAKFLARE_BIN_DIR:-$HOME/.local/bin}"
CLI_ONLY=0
FORCE=0
BINARY="${DAKFLARE_BINARY:-1}"
NO_PACK="${DAKFLARE_NO_PACK:-0}"
NO_SETUP="${DAKFLARE_NO_SETUP:-0}"

usage() {
	cat <<'EOF'
usage: install.sh [--source|--binary] [--ref REF] [--dir DIR] [--bin-dir DIR] [--cli-only] [--no-pack] [--no-setup] [--force]

  --source         install the source checkout instead of the prebuilt binary
  --binary         prebuilt CLI binary (default; falls back to source)
  --ref REF        branch, tag or commit for the source checkout (default: main)
  --dir DIR        where the source checkout goes (default: ./dakflare)
  --bin-dir DIR    where the `dakflare` command is installed (default: ~/.local/bin)
  --cli-only       install only the CLI, not the Worker and console tree
  --no-pack        do not download the precompiled Worker pack
  --no-setup       install the files, but do not start the setup wizard
  --force          replace an existing --dir
  -h, --help       this text
EOF
}

die() {
	printf 'install: %s\n' "$1" >&2
	exit 1
}

# GitHub has one "latest" release, and this project marks pre-releases so they
# never become "latest". Resolve the newest release tag (pre-releases included)
# once, so an alpha's binary and pack are still installable from @latest.
release_base() {
	if [ -n "${DAKFLARE_RELEASE_BASE:-}" ]; then
		printf '%s\n' "$DAKFLARE_RELEASE_BASE"
		return
	fi
	if [ -n "${DAKFLARE_RELEASE_TAG:-}" ]; then
		printf 'https://github.com/%s/releases/download/%s\n' "$REPO" "$DAKFLARE_RELEASE_TAG"
		return
	fi
	tag=""
	if command -v curl >/dev/null 2>&1; then
		tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" 2>/dev/null |
			sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
	elif command -v wget >/dev/null 2>&1; then
		tag=$(wget -qO- "https://api.github.com/repos/$REPO/releases?per_page=1" 2>/dev/null |
			sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
	fi
	if [ -n "$tag" ]; then
		printf 'https://github.com/%s/releases/download/%s\n' "$REPO" "$tag"
	else
		printf 'https://github.com/%s/releases/latest/download\n' "$REPO"
	fi
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
	--binary)
		BINARY=1
		shift
		;;
	--source)
		BINARY=0
		NO_PACK=1
		shift
		;;
	--no-pack)
		NO_PACK=1
		shift
		;;
	--no-setup)
		NO_SETUP=1
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

# ---- prebuilt binary ------------------------------------------------------
# The source checkout needs Node before it can even link the CLI. The binary
# path does not: it installs the standalone CLI, then the Worker pack, and only
# `cf` (a Node package) remains for deployment.
if [ "$BINARY" -eq 1 ]; then
	RELEASE_BASE="$(release_base)"
	OS="$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
	ARCH="$(uname -m 2>/dev/null)"
	case "$OS" in
	linux) OS_NAME="linux" ;;
	darwin) OS_NAME="darwin" ;;
	mingw* | msys* | cygwin*) OS_NAME="windows" ;;
	*) OS_NAME="" ;;
	esac
	case "$ARCH" in
	x86_64 | amd64) ARCH_NAME="x64" ;;
	aarch64 | arm64) ARCH_NAME="arm64" ;;
	*) ARCH_NAME="" ;;
	esac
	if [ -n "$OS_NAME" ] && [ -n "$ARCH_NAME" ]; then
		ASSET="dakflare-$OS_NAME-$ARCH_NAME"
		[ "$OS_NAME" = "windows" ] && ASSET="$ASSET.exe"
		BTMP="$(mktemp -d "${TMPDIR:-/tmp}/dakflare-bin.XXXXXX")"
		trap 'rm -rf "$BTMP"' EXIT HUP INT TERM
		bfetch() {
			if command -v curl >/dev/null 2>&1; then
				curl -fsSL "$1" -o "$2"
			elif command -v wget >/dev/null 2>&1; then
				wget -qO "$2" "$1"
			else
				return 1
			fi
		}
		if bfetch "$RELEASE_BASE/$ASSET" "$BTMP/$ASSET" 2>/dev/null; then
			if bfetch "$RELEASE_BASE/$ASSET.sha256" "$BTMP/$ASSET.sha256" 2>/dev/null; then
				expected=$(cut -d' ' -f1 "$BTMP/$ASSET.sha256")
				if command -v sha256sum >/dev/null 2>&1; then
					actual=$(sha256sum "$BTMP/$ASSET" | cut -d' ' -f1)
				elif command -v shasum >/dev/null 2>&1; then
					actual=$(shasum -a 256 "$BTMP/$ASSET" | cut -d' ' -f1)
				else
					actual=""
				fi
				[ -z "$actual" ] || [ "$expected" = "$actual" ] ||
					die "the CLI binary failed its SHA-256 check"
			else
				printf 'warning: no CLI checksum published; continuing without verification\n' >&2
			fi
			mkdir -p "$BIN_DIR"
			install -m 0755 "$BTMP/$ASSET" "$BIN_DIR/dakflare"
			VERSION="$("$BIN_DIR/dakflare" --version 2>/dev/null)" || die "the binary was installed but does not run"
			printf 'DakFlare %s installed (prebuilt binary)\n' "${VERSION#dakflare }"
			printf '  command  %s\n' "$BIN_DIR/dakflare"

			PACK_DIR="${DAKFLARE_PACK_DIR:-$HOME/.local/share/dakflare/pack}"
			PACK_INSTALLED=0
			if [ "$CLI_ONLY" -eq 0 ] && [ "$NO_PACK" -eq 0 ]; then
				PACK_URL="${DAKFLARE_PACK_URL:-$RELEASE_BASE/dakflare-pack.tar.gz}"
				printf '\nFetching the precompiled Worker pack...\n'
				if bfetch "$PACK_URL" "$BTMP/pack.tar.gz" 2>/dev/null; then
					if bfetch "$PACK_URL.sha256" "$BTMP/pack.tar.gz.sha256" 2>/dev/null; then
						expected=$(cut -d' ' -f1 "$BTMP/pack.tar.gz.sha256")
						if command -v sha256sum >/dev/null 2>&1; then
							actual=$(sha256sum "$BTMP/pack.tar.gz" | cut -d' ' -f1)
						elif command -v shasum >/dev/null 2>&1; then
							actual=$(shasum -a 256 "$BTMP/pack.tar.gz" | cut -d' ' -f1)
						else
							actual=""
						fi
						[ -z "$actual" ] || [ "$expected" = "$actual" ] ||
							die "the Worker pack failed its SHA-256 check"
					fi
					mkdir -p "$BTMP/pack"
					if tar -xzf "$BTMP/pack.tar.gz" -C "$BTMP/pack" 2>/dev/null; then
						PACK_SRC=""
						for entry in "$BTMP/pack"/*; do
							if [ -d "$entry" ] && [ -f "$entry/pack.json" ]; then
								PACK_SRC="$entry"
								break
							fi
						done
						if [ -n "$PACK_SRC" ]; then
							rm -rf "$PACK_DIR"
							mkdir -p "$PACK_DIR"
							cp -R "$PACK_SRC/." "$PACK_DIR/"
							PACK_INSTALLED=1
							printf '  pack     %s\n' "$PACK_DIR"
						fi
					fi
				fi
				[ "$PACK_INSTALLED" -eq 1 ] ||
					printf '  warning  no release pack available; run with --source to build it\n'
			fi

			if [ "$CLI_ONLY" -eq 0 ] && [ "$PACK_INSTALLED" -eq 1 ]; then
			# A pack deploy still needs cf, and cf is Node today. Keep it private:
			# no sudo, no distro package drift, one checksum-verified Node 22.
			NODE_READY=0
			NODE_EXPORT=""
			if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
				node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
				NODE_READY=1
			fi
			if [ "$NODE_READY" -eq 0 ] && { [ "$OS_NAME" = "linux" ] || [ "$OS_NAME" = "darwin" ]; } &&
				[ -n "$ARCH_NAME" ] && [ ! -f /etc/alpine-release ]; then
				NODE_DIR="$HOME/.local/share/dakflare/node"
				if [ -x "$NODE_DIR/bin/node" ] &&
					"$NODE_DIR/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
					NODE_READY=1
				else
					printf '\nFetching a private Node 22 for cf...\n'
					if bfetch "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" "$BTMP/SHASUMS256.txt" 2>/dev/null; then
						node_file=$(awk -v p="-${OS_NAME}-${ARCH_NAME}.tar.gz" '$2 ~ p { print $2 }' "$BTMP/SHASUMS256.txt" | tail -1)
						node_sum=$(awk -v p="-${OS_NAME}-${ARCH_NAME}.tar.gz" '$2 ~ p { print $1 }' "$BTMP/SHASUMS256.txt" | tail -1)
						if [ -n "$node_file" ] && bfetch "https://nodejs.org/dist/latest-v22.x/$node_file" "$BTMP/$node_file" 2>/dev/null; then
							if command -v sha256sum >/dev/null 2>&1; then
								node_actual=$(sha256sum "$BTMP/$node_file" | cut -d' ' -f1)
							else
								node_actual=$(shasum -a 256 "$BTMP/$node_file" | cut -d' ' -f1)
							fi
							[ "$node_sum" = "$node_actual" ] || die "the private Node download failed its SHA-256 check"
							rm -rf "$NODE_DIR"
							mkdir -p "$NODE_DIR"
							tar -xzf "$BTMP/$node_file" -C "$NODE_DIR" --strip-components=1 ||
								die "the private Node archive did not extract"
							NODE_READY=1
						fi
					fi
				fi
				if [ "$NODE_READY" -eq 1 ]; then
					export PATH="$NODE_DIR/bin:$PATH"
					NODE_EXPORT="export PATH=\"$NODE_DIR/bin:\$PATH\""
					printf '  node     %s (private)\n' "$("$NODE_DIR/bin/node" --version)"
					if ! command -v cf >/dev/null 2>&1; then
						printf '  cf       installing...\n'
						if "$NODE_DIR/bin/npm" install -g --prefix "$NODE_DIR" --no-audit --no-fund cf@1.0.0-rc.2 >/dev/null 2>&1; then
							printf '  cf       %s\n' "$("$NODE_DIR/bin/cf" --version 2>/dev/null || echo installed)"
						else
							printf '  warning  cf install failed; install it with npm install -g cf@1.0.0-rc.2\n'
						fi
					fi
				fi
			fi

			fi

			if [ "$CLI_ONLY" -eq 0 ] && [ "$NO_SETUP" -eq 0 ] && [ -t 1 ] && [ -r /dev/tty ] &&
				[ "$PACK_INSTALLED" -eq 1 ] && [ "$NODE_READY" -eq 1 ]; then
				printf '\nStarting the setup wizard...\n\n'
				if ! DAKFLARE_PACK_DIR="$PACK_DIR" "$BIN_DIR/dakflare" setup < /dev/tty; then
					printf '\nSetup stopped. Run %s setup when you are ready.\n' "$BIN_DIR/dakflare"
				fi
			elif [ "$CLI_ONLY" -eq 0 ] && [ "$PACK_INSTALLED" -eq 1 ]; then
				printf '\nNext: DAKFLARE_PACK_DIR="%s" %s setup\n' "$PACK_DIR" "$BIN_DIR/dakflare"
				[ -n "$NODE_EXPORT" ] && printf '  %s  # for cf / pack deploy\n' "$NODE_EXPORT"
			fi
			if [ "$CLI_ONLY" -eq 0 ] && [ "$PACK_INSTALLED" -ne 1 ]; then
				printf '\nNext: re-run the installer to fetch the pack, or use --source to build from a checkout.\n'
			fi
			if [ "$CLI_ONLY" -eq 0 ] && [ "$PACK_INSTALLED" -eq 1 ] && ! command -v cf >/dev/null 2>&1; then
				printf '\ncf is required to deploy the pack: install Node 22+, then npm install -g cf@1.0.0-rc.2.\n'
			fi
			exit 0
		fi
		rm -rf "$BTMP"
		printf '\nwarning: no prebuilt binary for %s/%s; falling back to the source install\n' "$OS_NAME" "$ARCH_NAME"
	fi
fi

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

PACK_DIR="${DAKFLARE_PACK_DIR:-$HOME/.local/share/dakflare/pack}"
PACK_INSTALLED=0
if [ "$CLI_ONLY" -eq 0 ] && [ "$NO_PACK" -eq 0 ]; then
	PACK_URL="${DAKFLARE_PACK_URL:-$(release_base)/dakflare-pack.tar.gz}"
	printf '\nFetching the precompiled Worker pack...\n'
	if fetch "$PACK_URL" "$TMP/pack.tar.gz" 2>/dev/null; then
		if fetch "$PACK_URL.sha256" "$TMP/pack.sha256" 2>/dev/null; then
			expected=$(cut -d' ' -f1 "$TMP/pack.sha256")
			if command -v sha256sum >/dev/null 2>&1; then
				actual=$(sha256sum "$TMP/pack.tar.gz" | cut -d' ' -f1)
			elif command -v shasum >/dev/null 2>&1; then
				actual=$(shasum -a 256 "$TMP/pack.tar.gz" | cut -d' ' -f1)
			else
				actual=""
				printf '  warning  no sha256 tool; the pack checksum was not verified\n'
			fi
			[ -z "$actual" ] || [ "$expected" = "$actual" ] ||
				die "the Worker pack failed its SHA-256 check"
		else
			printf '  warning  no pack checksum published; continuing without verification\n'
		fi
		mkdir -p "$TMP/pack"
		if tar -xzf "$TMP/pack.tar.gz" -C "$TMP/pack" 2>/dev/null; then
			PACK_SRC=""
			for entry in "$TMP/pack"/*; do
				if [ -d "$entry" ] && [ -f "$entry/pack.json" ]; then
					PACK_SRC="$entry"
					break
				fi
			done
			if [ -n "$PACK_SRC" ]; then
				mkdir -p "$PACK_DIR"
				rm -rf "$PACK_DIR"
				mkdir -p "$PACK_DIR"
				cp -R "$PACK_SRC/." "$PACK_DIR/"
				PACK_VERSION=$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$PACK_DIR/pack.json" | head -1)
				printf '  pack     %s\n' "$PACK_DIR"
				[ -n "$PACK_VERSION" ] && printf '  version  %s\n' "$PACK_VERSION"
				PACK_INSTALLED=1
			fi
		fi
	fi
	if [ "$PACK_INSTALLED" -ne 1 ]; then
		printf '  warning  no release pack available; setup will use the checkout and build it\n'
	fi
fi

# A piped installer has no usable stdin for prompts; /dev/tty is the terminal
# the operator is looking at. Only start the wizard when there is one, and never
# fail an install that already succeeded because the wizard was declined.
if [ "$CLI_ONLY" -eq 0 ] && [ "$NO_SETUP" -eq 0 ] && [ -t 1 ] && [ -r /dev/tty ]; then
	printf '\nStarting the setup wizard...\n\n'
	if [ "$PACK_INSTALLED" -eq 1 ]; then
		if ! DAKFLARE_PACK_DIR="$PACK_DIR" "$BIN_DIR/dakflare" setup < /dev/tty; then
			printf '\nSetup stopped. Run %s setup when you are ready.\n' "$BIN_DIR/dakflare"
		fi
	elif ! "$BIN_DIR/dakflare" setup --checkout < /dev/tty; then
		printf '\nSetup stopped. Run %s setup --checkout when you are ready.\n' "$BIN_DIR/dakflare"
	fi
elif [ "$CLI_ONLY" -eq 0 ]; then
	if [ "$PACK_INSTALLED" -eq 1 ]; then
		printf '\nNext: DAKFLARE_PACK_DIR="%s" %s setup\n' "$PACK_DIR" "$BIN_DIR/dakflare"
	else
		printf '\nNext: %s setup --checkout\n' "$BIN_DIR/dakflare"
	fi
fi

case ":${PATH:-}:" in
*":$BIN_DIR:"*) ;;
*)
	printf '\n%s is not on PATH. Add it in this shell:\n' "$BIN_DIR"
	printf '  export PATH="%s:$PATH"\n' "$BIN_DIR"
	;;
esac

if [ "$CLI_ONLY" -eq 1 ]; then
	printf '\nCLI only: point it at an existing Worker with:\n'
	printf '  %s init --url <url> --token-file <file>\n' "$BIN_DIR/dakflare"
fi
