# ADR-0003 — SQLite + SQLCipher for local storage

**Status:** Accepted

Mirror of the [Notion ADR](https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b);
Notion is the source of truth.

### Context
We need durable local storage that survives crashes, supports concurrent reads during
capture, and can be encrypted at rest.

### Decision
SQLite with the SQLCipher extension, accessed via `rusqlite` (bundled feature).

### Rationale
- SQLite is the most reliable embedded DB in existence.
- SQLCipher adds transparent at-rest encryption with negligible runtime overhead.
- WAL mode gives concurrent readers without blocking the writer.
- No external dependency; bundled into the Rust binary.

### Alternatives considered
- **sled** — pure-Rust but less mature; API still settling.
- **plain files (JSONL)** — cheap and durable, but no querying for the future replay UI.
- **RocksDB** — overkill for our data volume.

### Implementation notes (forward-looking)
Single-writer pattern: one task owns the write connection via an mpsc command channel;
reads go through a read-only `r2d2` pool. The DB encryption key comes from the OS keychain.
Lands in M2.
