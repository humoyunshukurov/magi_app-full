//! Ports the student-report half of `features/cheatings/cheating.service.ts`.

use sqlx::PgPool;

use crate::access::{self, Timed};
use crate::cheatings::models::{CheatingRecord, CheatingType};
use crate::error::AppError;

const MAX_TEXT: usize = 1000;

fn parse_explanation(value: &str) -> Result<String, AppError> {
    let text = value.trim();
    if text.is_empty() {
        return Err(AppError::BadRequest("explanation is required".to_string()));
    }
    if text.len() > MAX_TEXT {
        return Err(AppError::BadRequest(format!("explanation must be at most {MAX_TEXT} characters")));
    }
    Ok(text.to_string())
}

/// A flagged attempt can still be graded later (out of scope here); a graded one is never
/// flagged again.
const FLAGGABLE: [&str; 3] = ["in_progress", "submitted", "auto_submitted"];

/// `POST /api/cheatings/attempts/:attempt_id`. Both writes (the incident and its attempt
/// link, plus the conditional flag) happen in one transaction - the TS version could not do
/// that over PostgREST and instead deleted the incident again by hand if a later step failed.
pub async fn create_incident(
    pool: &PgPool,
    attempt_id: i64,
    student_id: i64,
    name: CheatingType,
    explanation: &str,
) -> Result<CheatingRecord, AppError> {
    if !name.is_auto() {
        return Err(AppError::Forbidden("Only professors and examiners can record a manual review".to_string()));
    }
    let explanation = parse_explanation(explanation)?;

    let attempt = access::load_running_attempt(pool, attempt_id).await?;
    if !access::owns_attempt(pool, attempt_id, student_id).await? {
        return Err(AppError::NotFound("Attempt not found".to_string()));
    }
    if !access::is_running(&attempt) {
        return Err(AppError::Conflict("Incidents can only be reported while the attempt is in progress".to_string()));
    }
    if access::attempt_expired(pool, &Timed::from(&attempt)).await? {
        return Err(AppError::Conflict("Time is up: this attempt is over".to_string()));
    }

    let mut tx = pool.begin().await?;

    let (id, name, explanation, created_at) = sqlx::query_as::<_, (i64, CheatingType, String, chrono::DateTime<chrono::Utc>)>(
        "insert into public.cheatings (name, explanation) values ($1, $2) returning id, name, explanation, created_at",
    )
    .bind(name)
    .bind(&explanation)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("insert into public.cheating_reason (assignment_id, cheating_id) values ($1, $2)")
        .bind(attempt.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    // one conditional update, so a concurrently graded attempt is never flagged afterwards
    sqlx::query("update public.assignments set status = 'flagged' where id = $1 and status::text = any($2)")
        .bind(attempt.id)
        .bind(&FLAGGABLE[..])
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(CheatingRecord { id, name, explanation, created_at })
}
