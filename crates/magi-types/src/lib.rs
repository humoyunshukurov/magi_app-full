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

/// A question's in-progress answer as held in the encrypted local store between keystrokes
/// and the next sync to the backend (`PUT /api/attempts/:id/answers`).
///
/// Ids are plain JSON numbers on the wire, so they are pinned to `number` on the TypeScript
/// side instead of the `bigint` ts-rs would pick for `i64`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct AnswerDraft {
    #[ts(type = "number")]
    pub attempt_id: i64,
    #[ts(type = "number")]
    pub question_id: i64,
    /// Free-text answer (short answer / essay); empty for choice questions.
    pub answer: String,
    #[ts(type = "Array<number>")]
    pub option_ids: Vec<i64>,
    /// Seconds of active typing.
    pub typing_duration: u32,
    /// Characters typed.
    pub text_typed: u32,
    /// Operations that changed already-written text (deletes, replacements, mid-text inserts).
    pub text_edited: u32,
    /// Characters pasted in.
    pub text_pasted: u32,
    /// Paste (or drop) operations specifically, regardless of how many characters each carried.
    pub paste_events: u32,
    /// Delete operations specifically (a subset of `text_edited`).
    pub text_deleted: u32,
    /// Pauses longer than the freeze threshold between two inputs.
    pub freeze_count: u32,
    /// The longest such pause, in seconds.
    pub longest_freeze: u32,
    /// Seconds the question was on screen.
    pub time_spent: u32,
    /// RFC 3339 timestamps.
    pub started_at: Option<String>,
    pub answered_at: Option<String>,
}

/// One thing a student did (or that happened to them) during an attempt, kept in the encrypted
/// local store for the Activity page. Scoped to `user_id`, so the next person to sign in on the
/// same computer doesn't see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ActivityEvent {
    #[ts(type = "number")]
    pub user_id: i64,
    #[ts(type = "number")]
    pub attempt_id: i64,
    pub exam_name: String,
    /// RFC 3339, from the device clock.
    pub at: String,
    /// `attempt_started`, `attempt_resumed`, `identity_check` (ID number and photo), `camera_on`,
    /// `camera_off`, `camera_failed`, `camera_checks_off`, `camera_away`, `camera_back`,
    /// `phone_seen` (`camera_away`, `phone_seen` and `screenshot` carry a photo in `data`),
    /// `screenshot`, `screenshot_failed`, `question_opened`, `question_summary`, `paste` (from
    /// outside the exam, blocked), `devtools_attempt`, `monitor_added`, `monitor_removed`,
    /// `app_detected`, `app_closed`, `link_opened`, `link_closed`, `link_blocked`, `window_left`,
    /// `window_returned`, `sync_failed`, `sync_recovered`, `drafts_restored`, `attempt_submitted`,
    /// `auto_submitted`, `submit_failed`.
    pub kind: String,
    #[ts(type = "number | null")]
    pub question_id: Option<i64>,
    /// One readable line for the timeline.
    pub detail: String,
    /// Machine-readable extras as a JSON object (e.g. the counters of a `question_summary`).
    pub data: String,
}

/// An attempt that has activity recorded, for the Activity page's picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ActivityAttempt {
    #[ts(type = "number")]
    pub attempt_id: i64,
    pub exam_name: String,
    pub first_at: String,
    pub last_at: String,
    pub events: u32,
}

/// What the exam needs to know about the computer it runs on: how many screens are connected,
/// and whether any app that could help cheat (remote control, screen sharing or recording) or
/// any browser is open. Read before an exam starts and again while it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct EnvironmentReport {
    pub monitor_count: u32,
    /// Set on a developer's own computer (`MAGI_ALLOW_EXTRA_SCREENS=1`) so a second screen doesn't
    /// hold the exam back. Never set for students.
    pub extra_screens_allowed: bool,
    /// Remote control and screen sharing/recording apps that are running, by name.
    pub forbidden_apps: Vec<String>,
    /// Browsers that are running, by name.
    pub browsers: Vec<String>,
    /// Other apps' visible windows open besides this one, by name - empty where this can't be
    /// checked (Linux/Wayland gives no app a way to list other apps' windows).
    pub other_windows: Vec<String>,
    /// Set on a developer's own computer (`MAGI_ALLOW_OTHER_WINDOWS=1`) so an editor/terminal
    /// left open doesn't hold the exam back. Never set for students.
    pub other_windows_allowed: bool,
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
        AnswerDraft::export_all().expect("export AnswerDraft");
        ActivityEvent::export_all().expect("export ActivityEvent");
        ActivityAttempt::export_all().expect("export ActivityAttempt");
        EnvironmentReport::export_all().expect("export EnvironmentReport");
    }
}
