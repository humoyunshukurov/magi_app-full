//! Row/response types for the attempts domain ("assignments" in the schema - one student's
//! exam attempt), ported from `attempt.entities.ts`/`attempt.service.ts`. Everything here is
//! the student view: `flagged` is masked (see `service::student_status`) and grading fields
//! are withheld until `status == graded` - a real security boundary, not just formatting.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::deadline::TimeUnit;
use crate::exams::models::{ExamStatus, PermittedUrl};

/// `public.type_assignment_status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize, TS)]
#[sqlx(type_name = "type_assignment_status", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../frontend/src/generated/", rename_all = "snake_case")]
pub enum AttemptStatus {
    Pending,
    InProgress,
    Submitted,
    AutoSubmitted,
    Graded,
    Flagged,
}

/// `public.type_question_type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize, TS)]
#[sqlx(type_name = "type_question_type", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../frontend/src/generated/", rename_all = "snake_case")]
pub enum QuestionType {
    MultipleChoice,
    TrueFalse,
    ShortAnswer,
    Essay,
}

impl QuestionType {
    /// The types a professor has to grade by hand; everything else is graded at submit.
    pub fn is_manual(self) -> bool {
        matches!(self, QuestionType::ShortAnswer | QuestionType::Essay)
    }
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AttemptExamBrief {
    pub id: i64,
    pub name: String,
    pub scheduled_start: DateTime<Utc>,
    pub scheduled_end: DateTime<Utc>,
    pub status: ExamStatus,
    pub max_marks: i32,
    pub passing_marks: i32,
}

/// The student's view of one attempt. `score`/`passed`/`feedback` are only present once the
/// attempt is actually `graded` - never while it's running, submitted, or (internally)
/// flagged, matching the TS `studentSummary`.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AttemptSummary {
    pub id: i64,
    pub exam_id: i64,
    /// Masked: a student never sees `flagged` (see `service::student_status`).
    pub status: AttemptStatus,
    pub started_at: Option<DateTime<Utc>>,
    pub submitted_at: Option<DateTime<Utc>>,
    pub auto_submitted: bool,
    pub session_duration: i32,
    pub session_duration_unit: TimeUnit,
    pub expires_at: DateTime<Utc>,
    pub remaining_seconds: i64,
    pub exam: AttemptExamBrief,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub score: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub passed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub feedback: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AttemptQuestionOption {
    pub id: i64,
    pub option_text: String,
}

/// One question as it sits in an attempt. Never carries `is_correct` on its options; carries
/// `marks_awarded` only once the attempt is graded.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AttemptQuestion {
    pub question_id: i64,
    pub position: i32,
    pub title: String,
    pub question: String,
    pub question_type: QuestionType,
    pub expected_duration: i32,
    pub expected_duration_unit: TimeUnit,
    pub marks: i32,
    pub options: Vec<AttemptQuestionOption>,
    pub answer: String,
    pub selected_option_ids: Vec<i64>,
    pub typing_duration: i32,
    pub typing_duration_unit: TimeUnit,
    pub text_typed: i32,
    pub text_edited: i32,
    pub text_pasted: i32,
    pub started_at: Option<DateTime<Utc>>,
    pub answered_at: Option<DateTime<Utc>>,
    pub last_synced_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub marks_awarded: Option<i32>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AttemptDetail {
    #[serde(flatten)]
    #[ts(flatten)]
    pub summary: AttemptSummary,
    pub questions: Vec<AttemptQuestion>,
    pub permitted_urls: Vec<PermittedUrl>,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct StartAttemptRequest {
    pub exam_id: i64,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct AnswerInput {
    pub question_id: i64,
    pub answer: Option<String>,
    pub option_ids: Option<Vec<i64>>,
    pub typing_duration: Option<i32>,
    pub typing_duration_unit: Option<TimeUnit>,
    pub text_typed: Option<i32>,
    pub text_edited: Option<i32>,
    pub text_pasted: Option<i32>,
    pub started_at: Option<DateTime<Utc>>,
    pub answered_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct SyncAnswersRequest {
    pub answers: Vec<AnswerInput>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct SyncAnswersResponse {
    pub synced: usize,
    pub remaining_seconds: i64,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../frontend/src/generated/")]
pub struct SubmitResponse {
    pub attempt: AttemptSummary,
    pub message: String,
}
