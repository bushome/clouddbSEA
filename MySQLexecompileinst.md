# Building the SEA exe (clouddbSEA) — MySQL/cluster-operator target

## Quick reference: routine rebuild (source changed, same build/ folder)

Run these four in order, every time:

```powershell
npm run build

npx esbuild dist/main.js --bundle --platform=node --target=node24 --format=cjs --outfile=build/bundle.js --external:bufferutil --external:utf-8-validate --external:@nestjs/microservices --external:@nestjs/microservices/microservices-module --external:@nestjs/platform-socket.io

node --experimental-sea-config sea-config.json

node -e "require('fs').copyFileSync(process.execPath, 'build/clouddb-test.exe')"
npx postject build/cloudstorageapi.exe NODE_SEA_BLOB build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

That's it for a normal rebuild. Skip to **Launching** below.

Only revisit the **Setup** or **Situational** sections if the schema changed, `build/` is new, or something's actually broken.

---

## One-time setup (already done — don't repeat)

- **`sea-config.json`** must exist in the project root, pointing at the bundle/blob paths:
```json
  { "main": "build/bundle.js", "output": "build/sea-prep.blob", "disableExperimentalSEAWarning": true }
```
  Created once. No need to recreate unless the path names change.

## Only needed again if something specific changed

- **Copy `generated/mysql-client` into `build/`** — only if the Prisma schema changed and the client was regenerated, or `build/` is brand new and doesn't have this folder yet:
```powershell
  Copy-Item -Recurse "C:\Program Files\iisnode\www\clouddbSEA\generated\mysql-client" "C:\Program Files\iisnode\www\clouddbSEA\build\generated\mysql-client"
```
  Prisma's `engineType = "client"` reads a real on-disk `query_compiler_bg.wasm` file at runtime — esbuild bundles the JS that reads it, not the file itself, so this has to be copied by hand.

- **Place `config.json` next to the exe in `build/`** — one-time per folder. Leave it alone if it's already there and settings haven't changed.

---

## Launching

Always launch from an already-open terminal — double-clicking closes the console the instant the process exits, erasing any crash output before you can read it:

```powershell
cd "C:\Program Files\iisnode\www\clouddbSEA\build"
.\clouddb-test.exe
```

**Windows Firewall inbound prompt** may appear the first time, or again after a rebuild — `postject` produces a functionally new binary each time (different injected blob), so Firewall may treat it as unseen even at the same file path. Expected; allow it.

---

## Why the bundle needs those five `--external` flags

- **`bufferutil` / `utf-8-validate`** — `ws`'s optional native-perf addons, unused here. esbuild tries to resolve them at bundle time regardless, and fails since they're not installed.
- **`@nestjs/microservices`, `@nestjs/microservices/microservices-module`, `@nestjs/platform-socket.io`** — Nest's own `optionalRequire`/`loadPackage` calls to unused peer packages, wrapped in Nest's own try/catch *at runtime*. But esbuild resolves every `require()` at *bundle* time regardless of that wrapper, and hard-fails on packages that were never installed. Externalizing leaves the literal `require()` calls in the bundle; Nest's existing try/catch correctly catches the resulting failure at runtime, same as it would outside SEA.

**Run the esbuild command as a single line** — no backtick/caret line continuation. PowerShell's backtick only continues a line with *zero* trailing whitespace after it, and Command Prompt doesn't support backtick continuation at all. Either mistake passes a literal backtick through as a stray argument, and esbuild fails with a confusing "multiple input files" error.

## Why `__dirname`/config.json resolution works here

Inside SEA's injected main script, `__filename`/`module.filename` resolve to `process.execPath`, and `__dirname` to its containing directory (per Node's own docs) — a `config.json` sitting next to the packaged exe resolves exactly the way the project's existing `require.main.filename`-anchored config-loading pattern already expects. No special handling needed.

---

## Validated end-to-end (2026-09-04)

Clean boot (all modules/routes/gateway initialized, cluster self-registered from `config.json`), `GET /health` returning a real DB round-trip (`db:"ok"`), a real connected WS client driving deposit/deduction traffic with correct batching and atomic gating, and the `DupeDetectionService` 5-minute `@Cron` job firing on schedule and correctly flagging a real triggered burst — confirming decorator metadata, `@nestjs/schedule`, the `ws` gateway, and the full deposit/audit-log/Discord pipeline all survive SEA packaging intact.

# Building the watchdog exe (watchdog.exe)

No esbuild/bundling step needed — `watchdog.js` has zero third-party
dependencies (only Node built-ins: `child_process`, `http`, `path`, `fs`),
so it goes straight into SEA packaging as-is.

## One-time setup

`watchdog-sea-config.json` in the project root:
```json
{ "main": "watchdog/watchdog.js", "output": "build/watchdog-sea-prep.blob", "disableExperimentalSEAWarning": true }
```

## Every rebuild (only needed if watchdog.js itself changes)

```powershell
node --experimental-sea-config watchdog-sea-config.json
node -e "require('fs').copyFileSync(process.execPath, 'build/watchdog.exe')"
npx postject build/watchdog.exe NODE_SEA_BLOB build/watchdog-sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

## watchdog-config.json — required fields for exe-spawn mode

```json
{
  "appDir": "<folder containing the app exe>",
  "appEntry": "<app-exe-filename>.exe",
  "isExe": true,
  "healthUrl": "http://localhost:<port>/health",
  ...
}
```

`isExe: true` is required — without it, `watchdog.js` tries to run
`node <appEntry>` instead of the exe directly, and fails immediately.
Omitting `isExe` (or setting it false) preserves the original
`node dist/main.js`-style spawn behavior, for anyone still running the
watchdog against a plain Node deployment rather than a packaged exe.

## Launching

Run elevated (Administrator), or ensure the write ACL on the folder
containing `watchdog.log` allows the launching user write access —
otherwise the log file write fails silently (non-fatal; watchdog still
runs and still logs to console, just can't persist to disk).

```powershell
cd <folder with watchdog.exe and watchdog-config.json>
.\watchdog.exe
```

## Runtime footprint

`watchdog.exe` + `watchdog-config.json` only. No `node_modules`, no other
assets — nothing to bundle since there were no third-party dependencies
to begin with.

**Validated end-to-end (2026-09-04)**: spawned the packaged app exe
directly via `isExe`, confirmed clean boot and real client traffic, then
force-killed the app exe and confirmed detect → crash-count → backoff →
clean relaunch with a new PID — identical behavior to the pre-existing
`node dist/main.js` forced-kill test.