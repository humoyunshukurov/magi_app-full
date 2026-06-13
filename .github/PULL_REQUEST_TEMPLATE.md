<!-- Thanks for contributing to the MAGI Desktop App. Keep PRs small and focused. -->

## What & why

<!-- What does this change do, and why? Link the task and any ADRs it touches. -->

- Task: <!-- Notion Tasks DB: https://app.notion.com/p/3c0ae832d87f83b4893201b7aa64e4e9 -->
- ADRs touched: <!-- e.g. ADR-0007. Index: docs/adrs/README.md / Notion ADR page -->

## Type of change

- [ ] feat
- [ ] fix
- [ ] chore
- [ ] docs
- [ ] adr

## Checklist

- [ ] Branch follows naming (`feat/`, `fix/`, `chore/`, `docs/`, `adr/`)
- [ ] `cargo fmt --all --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo nextest run` (or `cargo test`) passes
- [ ] `pnpm --dir frontend test` and `pnpm --dir frontend typecheck` pass
- [ ] No event payload contains document text (zero-knowledge invariant)
- [ ] No tokens persisted to disk in plaintext (OS keychain only)
- [ ] TLS verification not disabled
- [ ] Generated TS bindings regenerated if `magi-types` changed (`cargo test -p magi-types`)
- [ ] Does **not** contradict an Accepted ADR (0001–0004, 0007); new decisions have an ADR

## Notes for reviewers

<!-- Anything that needs special attention, screenshots, or manual test steps. -->
