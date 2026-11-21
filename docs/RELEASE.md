# Cutting a release

A tag is the release. Push `v<version>` and `.github/workflows/release.yml` verifies, builds and
publishes; there is nothing else to press. Operators install **prebuilt** artifacts; they do not
need a repository checkout, an npm install, or a SvelteKit build.

## The steps

```bash
# 1. one version, where it lives
#    cli/bin/dakflare.js  → CLI_VERSION   (what `dakflare --version` prints)
#    worker/package.json  → version       (what the deployment is)
node worker/scripts/check-versions.mjs

# 2. commit, then tag the commit CI already proved
git commit -am "chore: 6.3.0"
git push
git tag v6.3.0
git push origin v6.3.0
```

The workflow refuses a tag that disagrees with either file — that is the whole reason
`check-versions.mjs` exists. A release that ships code calling itself something else is the
failure this prevents, and it is a one-line check rather than a memory.

## Pre-releases

A suffix in the tag makes GitHub treat the release as a pre-release, which is the point: an alpha
must never become the version a newcomer installs.

```bash
# the version string, not just the tag, carries the suffix — one version everywhere
#   cli/bin/dakflare.js  → CLI_VERSION = '6.3.0-alpha.2'
#   worker/package.json  → "version": "6.3.0-alpha.2"
git tag v6.3.0-alpha.2 && git push origin v6.3.0-alpha.2
```

The workflow passes `--prerelease --latest=false` when the tag contains `-alpha`, `-beta` or
`-rc`, so "Latest" stays on the last final release. A suffix only on the tag, with a clean version
in the code, is refused by `check-versions.mjs`: two names for one build is how a release ends up
lying about itself.

## What gets published

| Asset | Built from | Used by |
|---|---|---|
| `dakflare-linux-x64`, `dakflare-linux-arm64`, `dakflare-darwin-x64`, `dakflare-darwin-arm64`, `dakflare-windows-x64.exe` | `scripts/release/build-cli.mjs` (Bun compile) | the standalone `dakflare` CLI |
| `dakflare-pack-<version>.tar.gz`, `dakflare-pack.tar.gz` | `scripts/release/build-pack.mjs` | `dakflare up --pack`, `cf deploy --prebuilt` |
| `dakflare-cli-<version>.tar.gz` | the source checkout | contributors and the `--source` fallback |
| `*.sha256` | `sha256sum` | the installer and manual verification |

Every asset is also covered by a GitHub build-provenance attestation. Verify one
with `gh attestation verify dist/dakflare-linux-x64 --repo JonyBepary/dakflare`.

### The CLI binaries

The binaries are Bun-compiled standalone executables. They run `init`, `send`, `status`, `doctor`,
`setup`, `up --pack`, and every other CLI command without a Node installation. A pack deploy still
invokes `cf`, which is currently a Node package; the installer reports that requirement. Replacing
`cf` with a direct Cloudflare API deployer is what would remove Node completely, and is what an
Android-initiated deploy needs.

### The Worker pack

The pack is a Cloudflare **Build Output v1** directory plus the D1 migrations and `pack.json`:

```text
dakflare-pack-<version>/
  pack.json
  .cloudflare/output/v1/
    config.json
    workers/default/worker.config.json
    workers/default/bundle/
    workers/default/assets/        # console, landing, screenshots
  migrations/*.sql
```

It is built once with `cf build`; `cf deploy --prebuilt` uploads it without running a build. The
D1 and KV ids in `worker.config.json` are placeholders:

```text
__DAKFLARE_D1_ID__
__DAKFLARE_KV_ID__
```

`dakflare up --pack <dir>` creates or reuses the resources, replaces the placeholders, applies the
migrations with `--dir`, and runs:

```bash
cf deploy --prebuilt --secrets-file .dev.vars
```

No `npm install`, no `npm run build:dashboard`, and no Worker type-check happen on the operator's
machine.

### The installer

```bash
curl -fsSL https://raw.githubusercontent.com/JonyBepary/dakflare/main/install.sh | sh
```

It prefers the binary and pack: it downloads `dakflare-<os>-<arch>`, verifies its SHA-256, installs
the pack to `~/.local/share/dakflare/pack`, and starts `dakflare setup`. `--source` installs the
checkout instead; `--binary` forces the prebuilt path; `--no-pack` installs the CLI only;
`--no-setup` skips the wizard. If no binary exists for the platform, it falls back to the source
install.

The source archive still contains the CLI, the skills, the licence and the readme. The Worker and
console are no longer only deployed from a checkout; the pack is the supported operator path.

## What a tag does not publish yet

**The Android APK.** A release APK needs the signing keystore and its password, which live outside
the repository (`~/.config/dakflare/`). Build and sign it on the machine that holds the key —
`docs/PHONE_RELEASE.md` — and attach it by hand for now:

```bash
gh release upload v6.3.0 path/to/app-universal-release.apk
```

Attaching it automatically needs the keystore in release secrets; deploying from the app needs the
direct Cloudflare API deployer, because Android cannot run `cf`.

**Detached offline signatures and a channel manifest.** Every asset has a SHA-256 and GitHub
build-provenance attestation. A key that does not depend on GitHub, and one stable manifest for
independent `cli`, `pack` and `android` channels, are the next layer; see “Channels and
signatures” below.

**The D1 schema.** Migrations are applied with `cf d1 migrations apply` before the deploy that
needs them (`docs/OPS_DEPLOY.md`); a tag does not touch production.

## Channels and signatures

GitHub has one repository-wide `latest` release, not one per component. The intended channel
selector is a small manifest at a stable URL:

```text
https://github.com/JonyBepary/dakflare/releases/latest/download/manifest.json
```

```json
{
  "schema": 1,
  "channels": {
    "cli": {
      "version": "…",
      "assets": {
        "linux-x64": { "url": "…", "sha256": "…", "signature": "…" }
      }
    },
    "pack": { "version": "…", "url": "…", "sha256": "…", "signature": "…" },
    "android": { "version": "…", "url": "…", "sha256": "…", "certificate_sha256": "…" }
  }
}
```

Component releases can be versioned tags; a `channels` release (or a `channels` branch file)
carries the manifest and is the only “latest” consumers read. The installer already uses stable
asset names, so it can switch to the manifest without changing the download layout.

## Before tagging

The tag is cut from `main`, and `main` is what the Conformance Pipeline verified. If you tag a
commit whose CI is red, the release job will not catch it — it checks versions, CLI syntax and the
harness self-test, not the full suite, because re-running two minutes of checks on a commit that
already passed is a gate that teaches people to tag and wait twice. Look at the run for the commit
you are tagging; if it is not green, fix that instead.
