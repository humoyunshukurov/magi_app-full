# Contributing to the MAGI Desktop App

## Branch naming

Branch off `main` using a typed prefix:

- `feat/<short-desc>` — new functionality
- `fix/<short-desc>` — bug fixes
- `chore/<short-desc>` — tooling, deps, config
- `docs/<short-desc>` — documentation only
- `adr/<nnnn>-<short-desc>` — an ADR proposal or change

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`,
`docs:`, etc. Keep commits small and focused.

## The ADR process

Architecture decisions are recorded as ADRs. **Notion is the source of truth**
([ADR page](https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b)); `docs/adrs/` mirrors
the accepted ones for code-adjacent reference.

1. **Before writing code that makes a non-trivial architectural decision**, check whether an
   ADR already covers it. Accepted ADRs (0001–0004, 0007) are binding — code must not
   contradict them.
2. If no ADR covers the decision, **propose one first**. Use the `/new-adr` Claude Code
   command (drafts land in `.claude/adrs-drafts/`) or copy the template from the Notion ADR page.
3. Get the ADR to **Accepted** (Tech Lead sign-off) before merging code that depends on it.
4. When an ADR is accepted, add/update its mirror in `docs/adrs/` and link it from
   `docs/adrs/README.md`.

## Code style

**Rust**
- `cargo fmt --all` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- No `unwrap()` / `expect()` / `panic!` in non-test code; return `Result`.
- Library errors via `thiserror`; app-layer errors via `anyhow`.
- No `unsafe` without a `// SAFETY:` comment stating the invariant.
- No blocking I/O in async contexts. Single-writer pattern in `magi-storage`.
- New dependencies must pass `cargo deny` (license + advisories).

**TypeScript**
- Strict mode, **no `any`**. `pnpm --dir frontend typecheck` must pass.
- Validate every IPC payload at runtime with zod; tie schemas to the generated `magi-types`.
- Global state only via `zustand`; server-state via `@tanstack/react-query`.
- Don't hand-write IPC types — import from `frontend/src/generated/`.

## Non-negotiable invariants

- No document text in any event payload (event payloads carry key *class*, not characters).
- Tokens only in the OS keychain — never plaintext on disk.
- Never disable TLS verification.
- Never bypass the event hash-chain.
- No analytics / browser-tracking SDKs.

## Required status checks (repo admin setup)

Configure branch protection on `main` so merges require these CI checks to pass
(see `.github/workflows/ci.yml`):

- `Rust lint + test (ubuntu)`
- `Frontend typecheck + test`
- `Build (macos-13)`, `Build (windows-2022)`, `Build (ubuntu-22.04)`

In GitHub: **Settings → Branches → Add branch protection rule** for `main` →
**Require status checks to pass before merging** → select the checks above. Also enable
**Require a pull request before merging**.

## Review expectations

- Keep PRs reviewable (< ~400 lines of diff where possible).
- Fill out the PR template, including ADRs touched and the invariant checklist.
- At least one approval before merge. Security-sensitive changes (auth, IPC, storage, crypto,
  enforcement, deep-link claim) should get a security-focused review.
