# The hardened runtime: a flag that is not honoured under an ad-hoc signature

## 1. What this fixes

### 1.1 It starts from one concrete attack path

`package-mac.mjs`'s header comment already admits this build has no application
integrity checking: `asar: false`, neither asar integrity fuse applies, and
**nothing can detect a modified `out/main/index.js`**.

What this asks about is the path beside it: **`DYLD_INSERT_LIBRARIES`
injection**.

It is worth asking separately because it penetrates the credential store more
thoroughly than editing a JS file does. `main/config/secrets.ts` hands database
passwords to `safeStorage`, the key lands in the system keychain, and the entry's
ACL recognises **the main binary's code signing identity**. Injecting a dylib
**does not change the main binary's cdhash** — not one byte of what the ACL
checks moves — so the injected code is waved through silently as peek, and
decrypts every stored password.

The `EnableNodeOptionsEnvironmentVariable` that `flipSecurityFuses` turns off
blocks injection at the Electron layer (`NODE_OPTIONS=--require evil.js`). dyld
is a layer below that, where the fuse does not reach.

The apparent fix is standard: enable the **hardened runtime**
(`codesign --options runtime`). One of its established effects is exactly this —
dyld strips `DYLD_*` environment variables.

### 1.2 The conclusion, stated up front

**Under an ad-hoc signature, the hardened runtime is not honoured.** Measured;
all three flag combinations were ineffective.

This change therefore **does not alter `package-mac.mjs`'s signing behaviour**.
It nails the finding into the repository instead.

### 1.3 Boundary

Not done: Developer ID signing, notarization, asar integrity checking, and
signature or hash validation of `~/.peek/packages/` (the last is decision 6 of
`2026-08-07-database-packages-from-disk.md` and out of scope here).

## 2. What was measured

### 2.1 Method

The probe is a dylib with an `__attribute__((constructor))` that prints a
sentinel to stderr as soon as it loads:

```c
__attribute__((constructor))
static void announce(void) { fprintf(stderr, "PEEK_DYLD_INJECTION_RAN\n"); fflush(stderr); }
```

What `cc -dynamiclib` produces is `adhoc,linker-signed` — a library signed by no
trusted identity, which is what an attacker would be holding.

The target starts in an isolated environment (`PEEK_CONFIG_DIR` at a temporary
directory, `PEEK_MCP_PORT` at an unused port, `PEEK_NO_RESTORE=1`), runs for 8
seconds, is killed by process group, and the sentinels in stderr are counted.

**This method carries a positive control, and the control is mandatory** (for the
reason given from line 33 of `verify-fuses.mjs`): "the sentinel did not appear" is
also what a mistyped command, a wrong path, or a process dying instantly looks
like. So every round also runs a target that **must** succeed.

### 2.2 Results

| target | signature flags | injected |
|---|---|---|
| peek as shipped | `0x2(adhoc)` | yes |
| peek + `--options runtime` | `0x10002(adhoc,runtime)` | **still yes** |
| peek + `--options runtime,restrict` | `0x10802(adhoc,restrict,runtime)` | **still yes** |
| the dev Electron in `node_modules` | `0x20002(adhoc,linker-signed)` | yes (the control; must be true) |
| **VS Code** | `0x10000(runtime)` + Developer ID | **blocked** |

On each of peek's three rows the sentinel appears **4 times** — the main process
plus three helpers, with the injection inherited down the whole process tree.

The last two rows carry all this table's weight. VS Code and peek are the same
kind of thing (an Electron app with the same helper structure) with the same
`runtime` hardening flag, and the only difference is the **Developer ID
signature**.

The `restrict` (CS_RESTRICT) row exists to rule out "was the wrong flag chosen" —
Chrome carries it (`0x12a00`), and adding it to peek is equally ineffective.

### 2.3 The cause

These restrictions are enforced by **AMFI** (Apple Mobile File Integrity), and
AMFI honours them only for signing identities it recognises: Developer ID, App
Store, or an Apple platform binary. An ad-hoc signature is local development code
in its eyes, subject only to a minimal cdhash integrity check, and neither the
`runtime` nor the `restrict` bit is translated into any actual behaviour.

**The hardened runtime is not a self-sufficient switch; it is a claim that needs a
trusted signature to underwrite it.**

## 3. The plan

### 3.1 Signing behaviour does not change

`signAdHoc` stays as it is. Sticking an unhonoured `runtime` flag on the build
buys nothing, and costs this: `codesign -dvvv`'s output would lead whoever reads
it — including oneself six months from now — to believe this path was closed.

This is the same discipline as `package-mac.mjs`'s header comment saying "Read
that function's comment before concluding that fuses closed this".

### 3.2 The finding is nailed beside `package-mac.mjs`

A passage is added under the ad-hoc signing entry in the header comment: the
hardened runtime was tried, it does not work, why, and what it requires. The
reason is the mirror image of
`2026-08-12-guards-nailed-to-shipped-code.md` — if assertions must be nailed to
what ships, then **"we tried this path and it does not work" must be nailed where
whoever goes to try it will necessarily read it**. Whoever goes to try it reads
the packaging script, not the fifty-third document in `docs/design/`.

### 3.3 No `verify-signing.mjs`

Writing a verification script that runs the real injection test and goes honestly
red was considered, and rejected: a check that is red by design reads as a
reminder on the maintainer's machine and as "did I break something?" on a new
contributor's. Every guard in this repository is an assertion that **should be
green right now**.

Write it the day Developer ID is in place, when it will be a check that goes
green.

## 4. Trade-offs

### 4.1 Considered: add it anyway, as groundwork

Add `--options runtime` and the entitlements so that the day a certificate exists
it takes effect immediately.

Rejected because of open source: every build somebody produces with
`git clone && pnpm package` is ad-hoc, and that flag will **never** take effect
for them. A claim that only becomes true after the maintainer buys a certificate
some day is the wrong default to bake into a project everyone builds themselves.

### 4.2 Considered: get Developer ID now

$99 a year. What is rejected is not the money but the timing: it protects only
the one binary the maintainer publishes by hand, and peek has published no binary
at all (`package-mac.mjs`'s header comment: no dmg, no auto-update).

**The trigger is recorded here**: the first time a `.dmg` or `.zip` goes up to a
GitHub Release, Developer ID stops being a security nicety and becomes whether the
user can open the thing — an un-notarized app downloaded through a browser is
stopped dead by Gatekeeper. On that day this is not optional.

### 4.3 What to change on that day (verified; copy it out)

The probing settled the configuration along the way, recorded here so it does not
have to be redone:

**Exactly two entitlements**:

```xml
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
```

The two others common in Electron community templates are **both wrong here**:

- `com.apple.security.cs.allow-dyld-environment-variables` — it reopens precisely
  the hole this document is about. With it, even a Developer ID signature buys
  nothing.
- `com.apple.security.cs.disable-library-validation` — needed only to load
  third-party native modules. peek's build contains **zero** `.node` files and
  **zero** `.dylib` files (SQLite goes through node's built-in `node:sqlite`, not
  `better-sqlite3`), so it is unnecessary.

**Ad-hoc plus the hardened runtime starts correctly** (ineffective, but it proves
these entitlements are not missing anything): the full process tree comes up — GPU
helper, network service, the `--enable-sandbox` renderer, and the ACP agent child
forked by utilityProcess — stderr is clean, and the MCP port answers within 7
seconds.

**One point not yet verified**: Developer ID plus the hardened runtime genuinely
enables library validation, at which point a package in `~/.peek/packages/`
carrying a native module would be refused. Every package today is pure JS, so the
problem does not exist; on the day it does, the answer is not to add
`disable-library-validation` but to first think through whether decision 6 (load
without validating) and a hardened host process can coexist.

### 4.4 Noted along the way: an ad-hoc signature's DR is a cdhash

```
# designated => cdhash H"5cc1a39eee3786b32df45db2a5e514b1c8be6b50"
```

A Developer ID signature's designated requirement binds the team ID and bundle ID
and is stable across versions; an ad-hoc one binds the hash of this particular
binary. The consequence is that **every `pnpm package` invalidates the keychain
ACL**, and macOS shows the authorisation dialog again every time.

The real cost is not that click, it is that it trains a person to allow whenever
they see peek asking for the keychain — and that dialog is the last door standing
between them and a process impersonating peek. This too disappears the day
Developer ID is in place.

## 5. Verification

This change touches only documentation and comments, and has no executable
assertion. The probing already run is recorded in §2; to re-run it:

1. Build the probe: `cc -dynamiclib -o inject.dylib inject.c` (source in §2.1)
2. Run the control (**the sentinel must appear**, or the next step's "it did not
   appear" proves nothing):
   ```
   DYLD_INSERT_LIBRARIES=./inject.dylib ELECTRON_RUN_AS_NODE=1 \
     apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
     -e "process.exit(0)"
   ```
3. Run the packaged build in an isolated environment, kill it by process group
   after 8 seconds, and count the sentinels in stderr.

Should the conclusion ever invert (Apple changing how AMFI treats ad-hoc
signatures), §3.1's decision should be revisited.
