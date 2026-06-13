# magi-types

Shared types and the **IPC contract** between the Rust core and the React frontend
(ADR-0002). Types here derive `serde` for transport and `ts-rs` for TypeScript generation.

The frontend never hand-writes IPC types — it imports the generated bindings from
`frontend/src/generated/types.ts` and pairs them with zod schemas for runtime validation.

## Regenerating the TypeScript bindings

`ts-rs` emits bindings from a test (a build script cannot reference the crate's own types,
since it runs before the crate is compiled). Run:

```sh
cargo test -p magi-types export_bindings
```

This writes `frontend/src/generated/types.ts`. The generated file is committed so the
frontend builds without first running Cargo. Regenerate whenever a `#[derive(TS)]` type
changes; CI checks the file is up to date.
