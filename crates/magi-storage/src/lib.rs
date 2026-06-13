//! SQLite + SQLCipher storage, migrations, and the repository layer (ADR-0003).
//!
//! M0 scope: skeleton only. The single-writer task, `refinery` migrations, and
//! repositories land in M2. Single-writer pattern is non-negotiable.

/// Errors originating in the storage layer.
#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    /// A database operation failed.
    #[error("storage error: {0}")]
    Db(String),
}
