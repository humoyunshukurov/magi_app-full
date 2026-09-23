//! When one attempt is over: its own session limit, and never later than the exam window.
//!
//! Ports `lib/deadline.ts` from the TS backend field for field. The attempts, monitoring and
//! cheatings domains share [`deadline`]/[`attempt_expired`] so a student side write is judged
//! by the same clock everywhere.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `public.type_time_unit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize, TS)]
#[sqlx(type_name = "type_time_unit", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../frontend/src/generated/", rename_all = "lowercase")]
pub enum TimeUnit {
    Seconds,
    Minutes,
    Hours,
    Days,
}

impl TimeUnit {
    pub fn to_seconds(self, value: i32) -> i64 {
        let factor: i64 = match self {
            TimeUnit::Seconds => 1,
            TimeUnit::Minutes => 60,
            TimeUnit::Hours => 3600,
            TimeUnit::Days => 86400,
        };
        i64::from(value) * factor
    }
}

/// The exam-side inputs `deadline` needs: nothing closes an attempt later than this window.
pub struct Window {
    pub scheduled_start: DateTime<Utc>,
    pub scheduled_end: DateTime<Utc>,
}

/// `min(started_at + session_duration, scheduled_end)`; `started_at` falls back to the exam's
/// scheduled start for an attempt that has one (every attempt does, in practice - `start_attempt`
/// always writes it), matching the TS `deadline()`.
pub fn deadline(
    started_at: Option<DateTime<Utc>>,
    session_duration: i32,
    session_duration_unit: TimeUnit,
    window: &Window,
) -> DateTime<Utc> {
    let started = started_at.unwrap_or(window.scheduled_start);
    let candidate = started + Duration::seconds(session_duration_unit.to_seconds(session_duration));
    candidate.min(window.scheduled_end)
}
