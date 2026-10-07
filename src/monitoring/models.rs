//! Monitoring media: the four proctoring capture kinds. Student uploads only this pass -
//! staff listing/deletion (`monitoring.service.ts`'s `listMedia`/`deleteMedia`) is out of
//! scope.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AddMediaRequest {
    /// A `data:image/...;base64,...` string (or bare base64) - uploaded to Storage server-side.
    pub image: String,
    /// What the photo shows, e.g. "ID number 12" or "Phone seen at 05:32".
    pub label: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct MediaRecord {
    pub id: i64,
    pub url: String,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
}
