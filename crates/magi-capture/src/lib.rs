//! Event capture, batching, and the prev-hash chain (ADR-0007).
//!
//! M0 scope: crate skeleton only. The event emitter, batcher, and hash chain land in M1.
//! Invariant to uphold here forever: event payloads carry behavioral metadata (key
//! *class*, lengths, timing) — never document characters.

/// Errors originating in the capture layer.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    /// The hash chain could not be extended (e.g. a missing predecessor).
    #[error("event chain error: {0}")]
    Chain(String),
}
