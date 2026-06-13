//! Shared types and the IPC contract between the Rust core and the React frontend.
//!
//! Every type that crosses the Tauri IPC boundary lives here and derives both
//! [`serde`] (for transport) and [`ts_rs::TS`] (for TypeScript generation). See
//! ADR-0002 (workspace split) and ADR-0010 (deep-link launch protocol).

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

/// Newtype over a session UUID (v4). Keeps session ids from being confused with
/// other identifiers at the type level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct SessionId(pub Uuid);

impl SessionId {
    /// Generate a fresh random session id.
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// The three configurable integrity levels (see Integrity Levels deep dive).
///
/// Serialized as the integers `1 | 2 | 3` to match the backend `SessionConfig`
/// and the local SQLite `assignments.integrity_level` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(into = "u8", try_from = "u8")]
// ts-rs can't see through the serde `into`/`try_from`, so pin the wire shape explicitly:
// the value is transported as the integers 1 | 2 | 3, not a string union.
#[ts(
    export,
    export_to = "../../../frontend/src/generated/",
    type = "1 | 2 | 3"
)]
#[repr(u8)]
pub enum IntegrityLevel {
    /// Passive logging only.
    Open = 1,
    /// Network whitelist enforced; violations surfaced.
    Guarded = 2,
    /// Full kiosk lockdown.
    Lockdown = 3,
}

impl From<IntegrityLevel> for u8 {
    fn from(level: IntegrityLevel) -> Self {
        level as u8
    }
}

impl TryFrom<u8> for IntegrityLevel {
    type Error = IntegrityLevelError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Open),
            2 => Ok(Self::Guarded),
            3 => Ok(Self::Lockdown),
            other => Err(IntegrityLevelError(other)),
        }
    }
}

/// Error returned when an integer outside `1..=3` is converted to an [`IntegrityLevel`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IntegrityLevelError(pub u8);

impl std::fmt::Display for IntegrityLevelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "invalid integrity level: {} (expected 1, 2, or 3)",
            self.0
        )
    }
}

impl std::error::Error for IntegrityLevelError {}

/// Response payload for the demo `ping` IPC command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct PingResponse {
    /// Human-readable message, e.g. `"pong from magi-core"`.
    pub message: String,
    /// The core crate version, so the frontend can confirm what it's talking to.
    pub core_version: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integrity_level_round_trips_through_u8() {
        for (level, n) in [
            (IntegrityLevel::Open, 1u8),
            (IntegrityLevel::Guarded, 2),
            (IntegrityLevel::Lockdown, 3),
        ] {
            assert_eq!(u8::from(level), n);
            assert_eq!(IntegrityLevel::try_from(n).unwrap(), level);
        }
        assert!(IntegrityLevel::try_from(0).is_err());
        assert!(IntegrityLevel::try_from(4).is_err());
    }

    #[test]
    fn integrity_level_serializes_as_integer() {
        let json = serde_json::to_string(&IntegrityLevel::Guarded).unwrap();
        assert_eq!(json, "2");
    }

    /// Generates `frontend/src/generated/*.ts` from the `#[derive(TS)]` types.
    ///
    /// `ts-rs` writes each exported type to the path in its `export_to` attribute
    /// when its generated test runs. This wrapper makes the intent explicit and
    /// gives CI a single target to invoke. Run `cargo test -p magi-types`.
    #[test]
    fn export_bindings() {
        SessionId::export_all().expect("export SessionId");
        IntegrityLevel::export_all().expect("export IntegrityLevel");
        PingResponse::export_all().expect("export PingResponse");
    }
}
