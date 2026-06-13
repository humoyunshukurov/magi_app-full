//! Backend REST client and retry queue (ADR-0004).
//!
//! M0 scope: skeleton only. The API client (claim, heartbeat, submit), token refresh,
//! and the persistent retry queue land in M3. TLS verification is never disabled.

/// Errors originating in the sync layer.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    /// A network or HTTP-level failure that is eligible for retry.
    #[error("transport error: {0}")]
    Transport(String),
}
