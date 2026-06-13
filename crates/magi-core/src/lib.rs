//! Session lifecycle and state machine for the MAGI Desktop App (ADR-0002).
//!
//! M0 scope: a demo [`ping`] that proves the IPC path from React → `magi-app` →
//! `magi-core`. The session state machine arrives in M1.

use magi_types::PingResponse;

/// Errors originating in the core layer.
#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    /// A session transition was requested that the state machine forbids.
    #[error("invalid session transition: {0}")]
    InvalidTransition(String),
}

/// The version of this crate, surfaced to the frontend so it can confirm what it's
/// talking to across the IPC boundary.
#[must_use]
pub fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Demo command backing the `ping` IPC handler.
#[must_use]
pub fn ping() -> PingResponse {
    PingResponse {
        message: "pong from magi-core".to_string(),
        core_version: core_version().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_expected_message() {
        let resp = ping();
        assert_eq!(resp.message, "pong from magi-core");
        assert_eq!(resp.core_version, core_version());
    }
}
