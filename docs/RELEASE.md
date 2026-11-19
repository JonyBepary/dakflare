# Cutting a release

A tag is the release. Push `v<version>` and `.github/workflows/release.yml` verifies, assembles
and publishes; there is nothing else to press.

## The steps

```bash
# 1. one version, in both places it lives
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

## What gets published

`dakflare-cli-<version>.tar.gz` plus its `.sha256`, containing:

| | |
|---|---|
| `cli/` | the command itself — zero dependencies, Node 22+ |
| `skills/` | the four `SKILL.md` packages, so `npx skills add` works from the archive |
| `LICENSE` | AGPL-3.0 |
| `README.md` | what the product is and how to start |

The Worker and the console are **not** in the archive: they are deployed with `cf deploy`, not
downloaded. Shipping a copy of the Worker in a tarball would create a second thing claiming to be
the deployment.

## What a tag does not publish

**The Android APK.** A release APK needs the signing keystore and its password, which live
outside the repository (`~/.config/dakflare/`), and a sideloaded build is a decision rather than a
consequence. Build and sign it on the machine that holds the key —
`docs/PHONE_RELEASE.md` — and attach it by hand if you want it on the release:

```bash
gh release upload v6.3.0 path/to/app-universal-release.apk
```

**The D1 schema.** Migrations are applied with `cf d1 migrations apply` before the deploy that
needs them (`docs/OPS_DEPLOY.md`); a tag does not touch production.

## Before tagging

The tag is cut from `main`, and `main` is what the Conformance Pipeline verified. If you tag a
commit whose CI is red, the release job will not catch it — it checks versions, CLI syntax and the
harness self-test, not the full suite, because re-running two minutes of checks on a commit that
already passed is a gate that teaches people to tag and wait twice. Look at the run for the commit
you are tagging; if it is not green, fix that instead.
