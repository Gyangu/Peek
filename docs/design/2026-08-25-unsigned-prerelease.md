# An unsigned pre-release, published on purpose

## What to solve

peek has no installable artifact: no GitHub release, no tag. `package-mac.mjs` produces a
double-clickable `peek.app`, but it is ad-hoc signed — built for the machine that built it.
The design record so far (2026-08-15-hardened-runtime.md) ties Developer ID signing, hardened
runtime and notarization to "the first published binary".

The decision, made explicitly by the project owner on 2026-08-25, is to publish **before** that
point: a zip of the ad-hoc `.app` as a GitHub **pre-release**, with the Gatekeeper caveats stated
in the release notes rather than solved. The alternative — wait for an Apple Developer account —
was offered and declined for now.

Out of scope: signing, notarization, a dmg, auto-update, x64 or universal builds. The
hardened-runtime plan is unchanged; its trigger ("the first published .dmg") is deliberately not
this release. This is a zip, marked pre-release, and says on its face what it is not.

## Plan

- Tag `v0.0.1` (the version already in `apps/desktop/package.json`; nothing is bumped).
- Build (`pnpm build`), package (`node apps/desktop/scripts/package-mac.mjs`), zip with
  `ditto -c -k --keepParent` so the bundle's symlinks and metadata survive.
- GitHub release, `--prerelease`, one asset: `peek-v0.0.1-macos-arm64.zip`. The notes state:
  arm64 only, ad-hoc signature (no identity — `codesign --sign -`), and the two ways past
  Gatekeeper's "damaged" refusal (`xattr -d com.apple.quarantine`, or System Settings → Privacy &
  Security → Open Anyway).
- README (both languages) gains a short install note pointing at Releases, with the same caveat,
  above the build-from-source path.

## Trade-offs

- **Publish unsigned vs wait for Developer ID.** Waiting keeps the "first published binary is
  signed" line intact but ships nothing. Publishing now trades first-run friction (a scary dialog
  and one manual step) for an artifact people can actually try. Marking it pre-release and spelling
  the friction out is the middle the owner chose.
- **zip vs dmg.** A dmg would look more finished than the contents are; the 2026-08-15 doc also
  uses "the first .dmg" as the signing trigger, and this release must not masquerade as that.

## Verification

- `codesign --verify --deep --strict` passes on the packaged app (the script already does this);
  `codesign -dvvv` shows `Signature=adhoc` and no Authority/TeamIdentifier — no local signing
  identity leaks into the artifact.
- A recursive case-insensitive grep over the finished `.app` for strings that must not appear
  (per owner: "humanify") comes back empty.
- The zip round-trips: unzip elsewhere, the app launches.
