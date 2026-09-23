//! Shared "may this student touch this row" checks, ported from `lib/exam-access.ts` and the
//! `attemptExpired` half of `lib/deadline.ts`. The exams, attempts, monitoring and cheatings
//! modules all ask here so the rule is written once.

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::attempts::models::AttemptStatus;
use crate::deadline::{deadline, TimeUnit, Window};
use crate::error::AppError;

/// The exam window a live (not soft-deleted) exam has, or `None` if the exam is gone -
/// which, per the TS behavior, leaves nothing running.
pub async fn exam_window(pool: &PgPool, exam_id: i64) -> Result<Option<Window>, AppError> {
    let row = sqlx::query_as::<_, (DateTime<Utc>, DateTime<Utc>)>(
        "select scheduled_start, scheduled_end from public.exams where id = $1 and deleted_at is null",
    )
    .bind(exam_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(scheduled_start, scheduled_end)| Window { scheduled_start, scheduled_end }))
}

/// Is `student_id` assigned to sit `exam_id` (`exam_student`)?
pub async fn sits_exam(pool: &PgPool, exam_id: i64, student_id: i64) -> Result<bool, AppError> {
    let row = sqlx::query_scalar::<_, i64>(
        "select exam_id from public.exam_student where exam_id = $1 and student_id = $2",
    )
    .bind(exam_id)
    .bind(student_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.is_some())
}

/// Does `student_id` own attempt `attempt_id` (`student_assignment`)?
pub async fn owns_attempt(pool: &PgPool, attempt_id: i64, student_id: i64) -> Result<bool, AppError> {
    let row = sqlx::query_scalar::<_, i64>(
        "select assignment_id from public.student_assignment where assignment_id = $1 and student_id = $2",
    )
    .bind(attempt_id)
    .bind(student_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.is_some())
}

/// The bits of an attempt `deadline`/`attempt_expired` need.
pub struct Timed {
    pub exam_id: i64,
    pub session_duration: i32,
    pub session_duration_unit: TimeUnit,
    pub started_at: Option<DateTime<Utc>>,
}

/// Has this attempt run out of time? A soft-deleted exam counts as expired: an exam that is
/// gone leaves nothing running (same rule as the TS `attemptExpired`).
pub async fn attempt_expired(pool: &PgPool, attempt: &Timed) -> Result<bool, AppError> {
    let Some(window) = exam_window(pool, attempt.exam_id).await? else {
        return Ok(true);
    };

    let dl = deadline(attempt.started_at, attempt.session_duration, attempt.session_duration_unit, &window);
    Ok(Utc::now() >= dl)
}

/// The columns the monitoring and cheatings domains need from an attempt: just enough to
/// tell whether a student side write onto it is still allowed. Ported from the (identical)
/// `Attempt` type each of `monitoring.service.ts`/`cheating.service.ts` declares for itself.
pub struct RunningAttempt {
    pub id: i64,
    pub exam_id: i64,
    pub status: AttemptStatus,
    pub submitted_at: Option<DateTime<Utc>>,
    pub session_duration: i32,
    pub session_duration_unit: TimeUnit,
    pub started_at: Option<DateTime<Utc>>,
}

impl From<&RunningAttempt> for Timed {
    fn from(attempt: &RunningAttempt) -> Self {
        Timed {
            exam_id: attempt.exam_id,
            session_duration: attempt.session_duration,
            session_duration_unit: attempt.session_duration_unit,
            started_at: attempt.started_at,
        }
    }
}

pub async fn load_running_attempt(pool: &PgPool, attempt_id: i64) -> Result<RunningAttempt, AppError> {
    let row = sqlx::query_as::<_, (i64, i64, AttemptStatus, Option<DateTime<Utc>>, i32, TimeUnit, Option<DateTime<Utc>>)>(
        "select id, exam_id, status, submitted_at, session_duration, session_duration_unit, started_at \
         from public.assignments where id = $1 and deleted_at is null",
    )
    .bind(attempt_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Attempt not found".to_string()))?;

    Ok(RunningAttempt {
        id: row.0,
        exam_id: row.1,
        status: row.2,
        submitted_at: row.3,
        session_duration: row.4,
        session_duration_unit: row.5,
        started_at: row.6,
    })
}

/// An earlier cheating incident turns `in_progress` into `flagged` in the same column, so the
/// attempt is still "running" as long as it hasn't been submitted.
pub fn is_running(attempt: &RunningAttempt) -> bool {
    matches!(attempt.status, AttemptStatus::InProgress | AttemptStatus::Flagged) && attempt.submitted_at.is_none()
}
