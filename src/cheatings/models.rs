//! Cheating incidents. Student report only this pass - staff listing, dismissal and the
//! per-exam summary (`cheating.service.ts`'s `listIncidents`/`getIncident`/`dismissIncident`/
//! `examSummary`) are out of scope.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `public.type_cheating_types`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize, TS)]
#[sqlx(type_name = "type_cheating_types", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../frontend/src/generated/", rename_all = "snake_case")]
pub enum CheatingType {
    TabSwitchLimit,
    CopyPaste,
    Devtools,
    MultipleMonitors,
    FaceMismatch,
    ScreenShare,
    UnauthorizedApp,
    /// The one type a student may not report themselves - staff business only.
    ManualReview,
    PhoneSeen,
    CameraAway,
    LinkBlocked,
    AppClosed,
}

impl CheatingType {
    pub fn is_auto(self) -> bool {
        !matches!(self, CheatingType::ManualReview)
    }
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct CreateCheatingRequest {
    pub name: CheatingType,
    pub explanation: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct CheatingRecord {
    pub id: i64,
    pub name: CheatingType,
    pub explanation: String,
    pub created_at: DateTime<Utc>,
}
