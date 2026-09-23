//! Row/response types for the exams domain, field for field from `migrations/003_exam_schema.sql`.
//! Student read-only: only `STUDENT_EXAM_COLUMNS` from `exam.service.ts` are ever answered
//! with - no `shuffle_questions`, no `created_by`, no question bodies.

use chrono::{DateTime, Utc};
use serde::Serialize;
use ts_rs::TS;

/// `public.type_exam_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, TS)]
#[sqlx(type_name = "type_exam_status", rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../../frontend/src/generated/", rename_all = "lowercase")]
pub enum ExamStatus {
    Demo,
    Scheduled,
    Ongoing,
    Completed,
    Delayed,
    Cancelled,
}

impl std::fmt::Display for ExamStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            ExamStatus::Demo => "demo",
            ExamStatus::Scheduled => "scheduled",
            ExamStatus::Ongoing => "ongoing",
            ExamStatus::Completed => "completed",
            ExamStatus::Delayed => "delayed",
            ExamStatus::Cancelled => "cancelled",
        };
        f.write_str(text)
    }
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct PermittedUrl {
    pub id: i64,
    pub url: String,
}

/// What a student sees in the exam list (`GET /api/exams`).
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ExamSummary {
    pub id: i64,
    pub name: String,
    pub scheduled_start: DateTime<Utc>,
    pub scheduled_end: DateTime<Utc>,
    pub status: ExamStatus,
    pub max_marks: i32,
    pub passing_marks: i32,
}

/// What a student sees for one exam (`GET /api/exams/:id`): the summary plus the urls it
/// permits while sitting.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ExamDetail {
    #[serde(flatten)]
    #[ts(flatten)]
    pub exam: ExamSummary,
    pub permitted_urls: Vec<PermittedUrl>,
}
