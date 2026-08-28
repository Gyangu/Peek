# The app bundle takes the brand name

> 2026-08-28. The brand became `Peek` earlier today (PLAN §0, the reversed
> naming entry). The thing a user actually double-clicks is still `peek.app`.
> This closes that gap, and says what must not move with it.

## 1. What this fixes

`APP_NAME` is `'peek'` in three scripts. It decides four user-visible things:

| | today | why it is user-visible |
| --- | --- | --- |
| bundle directory | `peek.app` | what Finder lists, what the README tells people to drag |
| `CFBundleName` | `peek` | the menu bar, the About window |
| `CFBundleDisplayName` | `peek` | Finder's label, the Dock, Spotlight |
| build output | `release/peek-darwin-arm64/` | named in the README and in three scripts |

Every one of those is front matter by the definition used when the brand was
capitalised: a string a person reads, not an identifier a machine resolves. They
were left behind because that pass was scoped to prose and UI catalogues, and an
`.app` name is neither.

The README now reads oddly as a result — a page titled **Peek** that ends by
telling you to drop `peek.app` into Applications.

## 2. The approach

`APP_NAME` becomes `'Peek'` in `package-mac.mjs`, `install-mac.mjs` and
`verify-fuses.mjs`. @electron/packager takes it as both `name` and
`productName`, so the bundle directory, `CFBundleName` and `CFBundleDisplayName`
all follow from the one constant. The README's four `peek.app` mentions follow.

### 2.1 What must not move, and why

**The bundle identifier stays `io.github.gyangu.peek`.** macOS keys an
application's identity off `CFBundleIdentifier`, not off its name: Launch
Services registration, TCC permission grants, saved window state, and the
"default application" association are all filed under it. Changing it would not
rename this app; it would create a second one, and every permission the user
already granted would be asked for again. The identifier is not front matter —
it is the one string in the bundle that is genuinely a machine identifier.

**The configuration directory stays `~/.peek`.** It comes from
`PEEK_CONFIG_DIR_NAME` in `@peek/core` and has never been derived from
`APP_NAME`, so it does not move on its own — and it must not be moved by hand
either, because that directory holds the connection book, the workspace and the
chat history. A rename there would silently orphan every one of them.

That the two are independent is worth stating rather than assuming: it is the
reason this change cannot cost a user their settings.

### 2.2 The already-installed copy

On a case-insensitive volume — the macOS default — `/Applications/peek.app` and
`/Applications/Peek.app` are the same path, so `install-mac.mjs` removes the old
bundle and writes the new one exactly as it does for any upgrade. Measured on
this machine: APFS, case-insensitive, `/Applications/peek.app` present.

macOS also offers case-**sensitive** APFS, and there the two are different
directories: installing would leave the old `peek.app` beside the new `Peek.app`,
both registered, both launchable, sharing one bundle identifier and one
configuration directory. That is a worse failure than it looks — which of the
two Launch Services opens is unspecified.

So `install-mac.mjs` removes any bundle in `/Applications` whose name matches
the app name case-insensitively, rather than only the exact path it is about to
write. On a case-insensitive volume that is the same single removal it already
performed; on a case-sensitive one it is the difference between an upgrade and a
duplicate.

## 3. Trade-offs

**Rename the bundle identifier too, for consistency.** Rejected in §2.1. The
identifier is not a display name, and treating it as one costs the user every
permission they have granted.

**Leave the bundle as `peek.app` and call the mismatch harmless.** It is nearly
harmless — but the README is the argument against it: a document titled Peek
that instructs you to install `peek.app` reads like a packaging mistake, and the
first impression of an unsigned pre-release does not need help looking sloppy.

**Migrate `~/.peek` to `~/.Peek` as well.** Rejected, and not only for the cost.
A dotted directory in `$HOME` is a path, not a label; every comparable tool keeps
it lowercase (`~/.config`, `~/.ssh`, `~/.docker`) regardless of how the product
is spelled. Moving it would also make the change destructive for anyone with an
existing install, which nothing here justifies.

## 4. Verification

1. `pnpm --filter @peek/desktop package` produces
   `release/Peek-darwin-arm64/Peek.app`.
2. `plutil -p Peek.app/Contents/Info.plist` shows `CFBundleName` and
   `CFBundleDisplayName` as `Peek`, and `CFBundleIdentifier` **unchanged** at
   `io.github.gyangu.peek`.
3. `pnpm --filter @peek/desktop verify:fuses` passes against the renamed bundle
   — it locates the binary at `Contents/MacOS/<APP_NAME>`, so a missed rename
   there surfaces as a missing file rather than a silent skip.
4. `pnpm --filter @peek/desktop install:local` leaves exactly one bundle in
   `/Applications`; `ls -d /Applications/[Pp]eek.app` prints one path.
5. Launch it, open a connection, and confirm `~/.peek/connections.json` is the
   same file the previous build wrote — the settings survive the rename.
