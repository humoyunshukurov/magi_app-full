# Architecture Decision Records (code-adjacent mirror)

These are markdown mirrors of the ADRs for reference next to the code. **Notion is the source
of truth** — full index and template:
https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b

| #    | Title                                                          | Status      |
|------|----------------------------------------------------------------|-------------|
| 0001 | [Use Tauri 2 for the desktop shell](0001-tauri-2-desktop-shell.md) | 🟢 Accepted |
| 0002 | [Workspace split by concern](0002-workspace-split-by-concern.md)   | 🟢 Accepted |
| 0003 | [SQLite + SQLCipher for local storage](0003-sqlite-sqlcipher.md)   | 🟢 Accepted |
| 0004 | REST + bearer auth (defer WebSocket sync to v2)                | 🟢 Accepted |
| 0005 | System proxy strategy for Level 2/3 network enforcement       | 🟡 Proposed |
| 0006 | Editor: custom controlled component on contenteditable        | 🟡 Proposed |
| 0007 | Tamper-evident event log via per-event prev-hash chain        | 🟢 Accepted |
| 0008 | Auto-updater channel design                                   | 🔴 Open     |
| 0009 | Multi-device session conflict policy                          | 🟡 Proposed |
| 0010 | Deep link launch protocol                                     | 🟡 Proposed |

ADRs 0001–0003 are mirrored here for M0; the rest live in Notion until they're touched by code.

To propose a new ADR, use the `/new-adr` Claude Code command (drafts land in
`.claude/adrs-drafts/`), then promote it to Notion once accepted.
