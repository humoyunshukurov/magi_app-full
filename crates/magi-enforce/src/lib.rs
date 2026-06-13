//! Platform enforcement, feature-gated per OS and integrity level (ADR-0002).
//!
//! M0 scope: skeleton + feature flags. Level 2 network proxy (ADR-0005) lands in M4;
//! Level 3 lockdown in M5.

/// Errors originating in the enforcement layer.
#[derive(Debug, thiserror::Error)]
pub enum EnforceError {
    /// Enforcement is not implemented for the current platform / feature set.
    #[error("enforcement unsupported: {0}")]
    Unsupported(String),
}
