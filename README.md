# MAGI Desktop App

Forensic-grade desktop client for the [MAGI University](https://magi-university.vercel.app/)
academic-integrity platform. Built in **Rust + Tauri 2** with a **React 18 + TypeScript**
frontend.

Students start every assignment on the web; a deep link (`magi://launch?token=…`) hands them
off to this desktop app, which captures the writing process as behavioral metadata, enforces
configurable integrity levels, and produces a tamper-evident forensic dossier.

> 📚 Full plan, architecture, ADRs, data model, and roadmap live in Notion (source of truth).
> Code-adjacent ADR mirror: [`docs/adrs/`](docs/adrs/README.md).

## Status

**M0 — Project Setup.** Workspace, Tauri scaffold, deep-link wiring, demo IPC, and CI.

## Prerequisites

- **Rust** stable (1.80+) — install via [rustup](https://rustup.rs); the repo pins `stable`
  via `rust-toolchain.toml`
- **Node** 20+ and **pnpm** 10+ (`npm i -g pnpm`)
- **Tauri CLI**: `cargo install tauri-cli --version "^2.0.0" --locked`
- **Platform deps** for Tauri — see the
  [Tauri prerequisites](https://tauri.app/start/prerequisites/):
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - Windows: WebView2 (preinstalled on Win 11) + MSVC Build Tools

## Quickstart (clone → running app, ~15 min)

```sh
git clone <repo-url> magi-app && cd magi-app

# 1. Frontend deps
pnpm --dir frontend install

# 2. Generate the TypeScript IPC bindings from magi-types
cargo test -p magi-types export_bindings

# 3. Run the app (builds Rust + starts Vite dev server)
cargo tauri dev
```

The window shows a demo screen that calls the `ping` IPC command (expect
`pong from magi-core`) and waits for a launch deep link.

### Test the deep link

With the app running, from another terminal:

```sh
# macOS
open 'magi://launch?token=stub'

# Linux
xdg-open 'magi://launch?token=stub'

# Windows (PowerShell)
Start-Process 'magi://launch?token=stub'
```

The Rust core parses the URL, emits `launch://received`, and the React UI logs and displays
the token. (Claiming the session against the backend is M3 — M0 only observes.)

## Workspace layout

```
Cargo.toml            # workspace root
rust-toolchain.toml   # pinned stable
crates/
  magi-types/         # shared types + IPC contract (ts-rs exports)
  magi-core/          # session lifecycle / state machine
  magi-capture/       # event capture + hash chain (ADR-0007)
  magi-enforce/       # platform enforcement (feature-gated)
  magi-storage/       # SQLite + SQLCipher (ADR-0003)
  magi-sync/          # backend REST client + retry queue (ADR-0004)
  magi-app/           # Tauri wiring + command handlers + deep link
src-tauri/            # thin Tauri binary (main.rs, tauri.conf.json, icons)
frontend/             # Vite + React 18 + TS + Tailwind
docs/adrs/            # code-adjacent ADR mirror
.github/              # CI + PR template
```

## Common commands

| Task                         | Command                                                        |
|------------------------------|---------------------------------------------------------------|
| Run the app (dev)            | `cargo tauri dev`                                              |
| Debug bundle                 | `cargo tauri build --debug`                                    |
| Rust format / lint           | `cargo fmt --all` · `cargo clippy --workspace -- -D warnings`  |
| Rust tests                   | `cargo nextest run --workspace` (or `cargo test`)             |
| Regenerate TS bindings       | `cargo test -p magi-types export_bindings`                     |
| Frontend test / typecheck    | `pnpm --dir frontend test` · `pnpm --dir frontend typecheck`  |

## Releasing a new version (ADR-0008)

Every installed app checks `.../releases/latest/download/latest.json` once per launch and
updates itself silently - no student action needed.

1. Bump `version` in `src-tauri/tauri.conf.json`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` (must match the version above).
3. `.github/workflows/release.yml` builds for macOS/Windows/Linux, signs the bundles with the
   `TAURI_SIGNING_PRIVATE_KEY` repo secret, and publishes them as a GitHub Release with
   `latest.json` attached.

### macOS Gatekeeper

The macOS build isn't notarized by Apple (that needs a paid Apple Developer Program
membership) - it's not a bug. `bundle.macOS.signingIdentity: "-"` in tauri.conf.json ad-hoc
signs it, which should mean students hit the milder "Apple could not verify this app" warning
(Privacy & Security → Open Anyway, no Terminal) rather than "is damaged and can't be opened."
If it still says "damaged", clear the quarantine flag instead:

```sh
xattr -cr "/Applications/MAGI Desktop.app"
```

To fix this for good, once there's a real Apple Developer account: add `APPLE_CERTIFICATE`
(base64 `.p12`), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_PASSWORD` (an app-specific password, not the Apple ID's own), and `APPLE_TEAM_ID` as
repo secrets, and add them back to `release.yml`'s `env:` block for the build step - leaving
any of them declared with no secret behind it breaks the build outright (tauri-action runs
`security import` the moment the env var exists, even as `""`), which is why they aren't
declared there right now.

`backend/` is the retired standalone Rust server (kept for history only - the desktop app
talks to `magi-backend` on Railway, not this).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the ADR process, and review
expectations.

## License

Proprietary — see [LICENSE](LICENSE).
