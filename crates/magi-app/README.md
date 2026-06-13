# magi-app

Tauri entry, command handlers, and wiring (ADR-0002). This is where the Rust core meets the
frontend: it builds the `tauri::Builder`, registers plugins, exposes IPC commands, and routes
incoming `magi://launch?token=…` deep links to the frontend (ADR-0010).

`src-tauri/src/main.rs` is a thin shim that calls [`run`] with the generated Tauri context;
all the actual wiring lives here so `main.rs` stays trivial.

## M0 surface

- `ping` IPC command → `PingResponse { message: "pong from magi-core", core_version }`
- Deep-link handler: parses `magi://launch?token=…`, logs it, and emits `launch://received`
  with `{ token }` to the frontend. (Claiming the session is M3 — M0 only observes.)
