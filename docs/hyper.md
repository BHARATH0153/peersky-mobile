
# Hyper protocol (mobile)

PeerSky Mobile includes a minimal Hyper runtime that runs inside a Bare worklet. This document explains what is included, how the RN UI talks to the runtime, basic developer steps, and some privacy/usage notes.

> This feature focuses only on the `hyper://` protocol using the Bare worklet. It intentionally excludes other protocols (IPFS/Web3) for now.

## Supported URL schemes

- `hyper://<drive>/` — access a Hyperdrive root
- `hyper://<drive>/<path>` — access a file or path inside a drive

Example: `hyper://akhilesh.art/` or `hyper://<drive-id>/index.html`

## Quick usage (manual smoke test)

1. Install deps: `npm install`
2. Produce the Bare bundle (creates `app/app.bundle.mjs`):

   npm run bundle:bare

3. Run the app (Android/iOS):

   npm run android
   # or
   npm run ios

4. In the app UI wait for `Hyper ready (...)` then:
   - Tap **Create Drive** — the app creates a writable Hyperdrive and returns a `hyper://...` URL.
   - Paste a `hyper://` URL (for example `hyper://akhilesh.art/`) and tap **Fetch URL** — expect a file listing or file contents.

## How it works (high level)

1. The React Native UI starts a Bare worklet using `Worklet.start()` and passes a storage path.
2. RN creates a `bare-rpc` client bound to the worklet IPC to send commands.
3. The worklet runs the bundled backend code which initializes `hyper-sdk` and exposes handlers for RPC commands.
4. Backend modules handle drive creation, file reads, and URL parsing and reply with JSON responses.

## Architecture (key files)

- `backend/backend.mjs` — Bare entry: starts RPC and manages lifecycle
- `backend/rpc/commands.mjs` — RPC command IDs
- `backend/rpc/router.mjs` — maps incoming RPC commands to handlers
- `backend/rpc/messages.mjs` — JSON / binary helpers
- `backend/hyper/runtime.mjs` — initialize/close `hyper-sdk`
- `backend/hyper/fetch.mjs` — simple `GET`-only fetch handler
- `backend/hyper/drive.mjs` — create a writable Hyperdrive and default `/index.html`
- `backend/hyper/url.mjs` — parse and normalize `hyper://` URLs
- `app/index.tsx` — RN test harness: starts worklet, creates RPC client, UI to create drives and fetch URLs

## RPC / API (contract)

The RN UI and worklet speak over `bare-rpc`. The primary commands are:

| Command | Request payload | Response |
|---------|-----------------|---------|
| `RPC_HYPER_INIT` | `{}` | `{ ok: true, storagePath }` or `{ ok: false, error }` |
| `RPC_HYPER_FETCH` | `{ url: string, method?: 'GET' }` | `{ ok: true, status, statusText, url, headers, body }` or `{ ok: false, error }` |
| `RPC_HYPER_CREATE_DRIVE` | `{ name?: string }` | `{ ok: true, status, statusText, url }` |

Responses may be returned as stringified JSON or as binary; the RN client converts binary to string using `b4a` and then parses JSON.

## Private drives

Hyperdrive uploads support three visibility modes:

- **Public** — written to the announced `hyperdrive-public` drive. Anyone with the URL can read it and browse the rest of that drive.
- **Private** — written to the `hyperdrive-private` drive, encrypted at the block level using a per-device 32-byte `encryptionKey` (`hyperdrive@13.3.3` passes it to `hypercore@11.35.2`, which does block encryption). Until device linking is enabled, the drive stays on this phone: any drive whose key is not on a device cannot be opened there, so in the current build a Private upload is locked to this device. The UI copy reflects that ("only this phone can read it"). The key is generated on first use and persisted in `private-drive-key.json` beside the synced private storage (`hyper-sdk-synced-private`). Applying a device-linked key is on the roadmap; when it lands, a drive carrying that key can be opened and replicated between your devices.
- **This device only** — written to the isolated `hyperdrive-device` drive with discovery and replication disabled (`autoJoin: false`, `doReplicate: false`). It never leaves the phone, so it is the right choice when nothing should leave the device at all.

> [!NOTE]
> A Private drive is device-only for now: its encryption key is generated and persisted on the phone, and it does not announce or replicate, so the storage claim matches the UI ("locked and only this phone can read them"). The key distribution mechanism (the device-linking channel described in `link-device.md`) is the path to multi-device reads; until a drive's key is present on a device, that device cannot open it.

## Developer notes

- The bundle (`app/app.bundle.mjs`) is generated from the `backend/` sources. Regenerate it after backend changes with `npm run bundle:bare`.
- Prefer not to commit the generated bundle; add `app/app.bundle.mjs` to `.gitignore` and keep `.standardignore` so the linter skips it.
- Keep `preandroid` / `preios` scripts to automatically bundle before native runs. Consider removing `prestart` to keep `expo start` fast during UI work.


> [!IMPORTANT]
> This implementation is an experimental Hyper runtime for development and testing. It is not a full browser UI and is intentionally scoped to protocol-level features. Do not use this as a production browser until further hardening, testing, and audits are completed.


