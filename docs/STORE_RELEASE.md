# Releasing the handset app

The app is one package (`dev.dakflare.device`) with one signing key, published to
four places that read the same artifact. This page is the contract they depend on;
`PHONE_RELEASE.md` covers building and signing.

## The artifact contract

Every release is a GitHub release whose tag starts `device-v`, carrying one APK
and its checksum:

```
device-v6.3.0
  DakFlare-Device-6.3.0-universal.apk
  DakFlare-Device-6.3.0-universal.apk.sha256
```

Rules that other channels assume:

- **`versionCode` strictly increases** and is the value in `tauri.conf.json`
  (`bundle.android.versionCode`), never derived from the version name.
- **One APK per release**, universal (`--target aarch64` still produces the
  universal artifact in `apk/universal/release`).
- **The asset name carries the version**, because Obtainium's extractor and
  IzzyOnDroid's scanner both read it.
- **The same key signs every release.** The certificate digest is recorded in
  `PHONE_RELEASE.md`; a key change is a new application id, not an upgrade.

Build and stage:

```sh
cd simulator
npx tauri android build --apk --target aarch64
cd ..
mkdir -p dist
cp simulator/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk \
   dist/DakFlare-Device-6.3.0-universal.apk
(cd dist && sha256sum DakFlare-Device-6.3.0-universal.apk > DakFlare-Device-6.3.0-universal.apk.sha256)
```

## Channel 1 — GitHub release (the source of truth)

```sh
gh release create device-v6.3.0 \
  dist/DakFlare-Device-6.3.0-universal.apk \
  dist/DakFlare-Device-6.3.0-universal.apk.sha256 \
  --title "DakFlare Device 6.3.0" --notes-file <notes>
```

Every other channel reads this release, so it is created first.

## Channel 2 — Obtainium

Nothing to submit. Obtainium is an installer, and it follows this repository:
source `https://github.com/JonyBepary/dakflare`, tag filter `device-v`, APK
filter `universal`. The contract above is the whole configuration. It can also
consume the IzzyOnDroid or self-hosted repo URL below, which survives a GitHub
outage.

## Channel 3 — IzzyOnDroid

They distribute the developer-signed APK and rebuild it to check reproducibility.
Request inclusion with one issue at
`https://codeberg.org/IzzyOnDroid/repodata/issues` containing:

- repo URL and the release URL of the newest APK,
- the signing certificate digest, so the rebuild can be compared,
- a note that the app needs a self-hosted gateway to be useful, and how to point
  it at one (a Worker URL plus a pairing code),
- confirmation that the build is reproducible, or that it is not yet and the
  badge should wait.

No code changes are needed for this channel.

## Channel 4 — F-Droid main repository

The draft recipe is `simulator/fdroid/dev.dakflare.device.yml`. It cannot build
yet: F-Droid builds offline, and this project fetches Node and Rust dependencies
at build time. Three things must land first:

1. Node dependencies vendored in-tree (Yarn Berry cache committed, or equivalent).
2. Rust dependencies vendored (`cargo vendor` plus `.cargo/config.toml`).
3. A pinned NDK revision that matches `tauri android build`.

Then `fdroid build` has to pass locally before the merge request, or it will sit.
The recipe requests `AllowedAPKSigningKeys`, which means F-Droid ships **your**
signature once the build is reproducible; without that, its APK is a separate
install island and a user switching to the GitHub build loses the app's data.

## Channel 5 — Self-hosted F-Droid repo

The fastest honest channel while F-Droid review runs, and the one to keep
afterwards. `fdroidserver` over GitHub Pages with the same key produces
`https://<you>.github.io/dakflare-fdroid/repo`, which Droid-ify, Neo Store,
F-Droid and Obtainium all accept. No review, no second signature.

## Channel 6 — Accrescent

Alpha, invite-by-contact (`contact@accrescent.app`), developer-signed with key
pinning, so the same key is mandatory. They will ask about the SMS and
notification permissions; the answer is that the app is a default SMS client and
the permissions are the product, not a side effect.

## Channels deliberately skipped

- **Google Play.** `READ_SMS`/`SEND_SMS` are restricted permissions there, and a
  self-hosted gateway is unlikely to clear the declaration. The fee is also not
  free.
- **Aptoide, Amazon, Huawei.** Free accounts, developer-signed, but each is
  another release lane and a second review for little reach.

## What every listing needs besides the APK

- icon 512×512 (`design/brand/store/icon-512.png`),
- feature graphic 1024×500 (`design/brand/store/feature-1024x500.png`),
- three to five screenshots at 1080×2400 or similar,
- a short description that says "bring your own Worker and a paired handset",
- a privacy statement: message bodies travel only to the operator's own Worker;
  no analytics, no third-party SDK, no FCM,
- the release notes for the version being listed.
