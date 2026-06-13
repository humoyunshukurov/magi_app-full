# ADR-0002 — Rust workspace structure: split by concern

**Status:** Accepted

Mirror of the [Notion ADR](https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b);
Notion is the source of truth.

### Context
A single monolithic crate becomes unmanageable past ~10k lines; we anticipate 30–50k.

### Decision
Cargo workspace with crates split by concern, not by layer:

```
magi-desktop/            # repo root (this repo)
  Cargo.toml             # workspace root
  crates/
    magi-app/            # Tauri entry, command handlers, wiring
    magi-core/           # session lifecycle, state machine
    magi-capture/        # event capture, batching, hash chain
    magi-enforce/        # platform-specific enforcement (feature flags)
    magi-storage/        # SQLite + migrations + repository
    magi-sync/           # backend API client, retry queue
    magi-types/          # shared types, serde, IPC contracts
  src-tauri/             # Tauri config + main.rs (thin)
  frontend/              # Vite + React app
```

### Rationale
- Concern-aligned crates make ownership clear (one team owns `magi-enforce` without blocking others).
- `magi-types` as the IPC contract crate lets us generate TypeScript via `ts-rs`.
- Compile times: a change in `magi-enforce` doesn't force a recompile of `magi-storage`.

### Implementation note (this repo)
The repo root *is* the workspace (the repo is named `magi-app`); we did not nest a separate
`magi-desktop/` directory. The Tauri binary lives in `src-tauri/` with a thin `main.rs` that
calls `magi_app::run(...)`, so `magi-app` owns all wiring per the ADR while `generate_context!`
still resolves against the binary crate.
