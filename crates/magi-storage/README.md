# magi-storage

SQLite + SQLCipher storage with `refinery` migrations and the repository layer (ADR-0003).

Design rules: **single writer** (one task owns the write connection via an mpsc command
channel), read-only `r2d2` pool for readers, WAL mode, DB key from the OS keychain. All JSON
is validated at the Rust boundary, never trusted from a DB row directly.

M0 ships the crate skeleton; schema, migrations, and repositories land in M2.
