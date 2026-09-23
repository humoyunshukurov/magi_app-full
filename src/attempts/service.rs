//! Attempts (table `assignments`): the core of the product. Ports the student half of
//! `features/attempts/attempt.service.ts` field for field - this is a real security
//! boundary (masking `flagged`, withholding grading fields), so it follows the TS logic
//! closely rather than taking shortcuts.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::access;
use crate::attempts::models::{
    AnswerInput, AttemptDetail, AttemptExamBrief, AttemptQuestion, AttemptQuestionOption, AttemptStatus,
    AttemptSummary, QuestionType, SubmitResponse, SyncAnswersResponse,
};
use crate::deadline::{deadline, TimeUnit, Window};
use crate::error::{map_unique_violation, AppError};
use crate::exams::models::{ExamStatus, PermittedUrl};

struct Exam {
    id: i64,
    name: String,
    scheduled_start: DateTime<Utc>,
    scheduled_end: DateTime<Utc>,
    status: ExamStatus,
    max_marks: i32,
    passing_marks: i32,
}

fn window_of(exam: &Exam) -> Window {
    Window { scheduled_start: exam.scheduled_start, scheduled_end: exam.scheduled_end }
}

struct Attempt {
    id: i64,
    exam_id: i64,
    session_duration: i32,
    session_duration_unit: TimeUnit,
    started_at: Option<DateTime<Utc>>,
    submitted_at: Option<DateTime<Utc>>,
    auto_submitted: bool,
    status: AttemptStatus,
    score: i32,
    feedback: Option<String>,
}

const ATTEMPT_COLUMNS: &str = "id, exam_id, session_duration, session_duration_unit, started_at, \
    submitted_at, auto_submitted, status, score, feedback";

type AttemptRow = (
    i64,
    i64,
    i32,
    TimeUnit,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    bool,
    AttemptStatus,
    i32,
    Option<String>,
);

fn attempt_from_row(row: AttemptRow) -> Attempt {
    Attempt {
        id: row.0,
        exam_id: row.1,
        session_duration: row.2,
        session_duration_unit: row.3,
        started_at: row.4,
        submitted_at: row.5,
        auto_submitted: row.6,
        status: row.7,
        score: row.8,
        feedback: row.9,
    }
}

/// `start_attempt` returns `to_json(new_attempt)` - a JSON *object* keyed by column name (plus
/// columns `AttemptRow` doesn't carry, like `created_at`), not the array `AttemptRow`'s tuple
/// `Deserialize` impl expects. This is its own shape for that reason.
#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct StartedAttemptRow {
    id: i64,
    exam_id: i64,
    session_duration: i32,
    session_duration_unit: TimeUnit,
    started_at: Option<DateTime<Utc>>,
    submitted_at: Option<DateTime<Utc>>,
    auto_submitted: bool,
    status: AttemptStatus,
    score: i32,
    feedback: Option<String>,
}

impl From<StartedAttemptRow> for Attempt {
    fn from(row: StartedAttemptRow) -> Self {
        Attempt {
            id: row.id,
            exam_id: row.exam_id,
            session_duration: row.session_duration,
            session_duration_unit: row.session_duration_unit,
            started_at: row.started_at,
            submitted_at: row.submitted_at,
            auto_submitted: row.auto_submitted,
            status: row.status,
            score: row.score,
            feedback: row.feedback,
        }
    }
}

// `flagged` is written by the cheatings domain and does not end the session, so an
// unsubmitted attempt (submitted or not, but not-yet-submitted here) stays "open".
fn is_open(attempt: &Attempt) -> bool {
    attempt.submitted_at.is_none() && matches!(attempt.status, AttemptStatus::InProgress | AttemptStatus::Flagged)
}

// `flagged` is staff business: a student reads the status the attempt would have without it.
fn student_status(attempt: &Attempt) -> AttemptStatus {
    if attempt.status != AttemptStatus::Flagged {
        return attempt.status;
    }
    if attempt.submitted_at.is_none() {
        AttemptStatus::InProgress
    } else if attempt.auto_submitted {
        AttemptStatus::AutoSubmitted
    } else {
        AttemptStatus::Submitted
    }
}

fn deadline_of(attempt: &Attempt, exam: &Exam) -> DateTime<Utc> {
    deadline(attempt.started_at, attempt.session_duration, attempt.session_duration_unit, &window_of(exam))
}

fn remaining_seconds(attempt: &Attempt, exam: &Exam) -> i64 {
    if !is_open(attempt) {
        return 0;
    }
    (deadline_of(attempt, exam) - Utc::now()).num_seconds().max(0)
}

async fn load_exam(pool: &PgPool, exam_id: i64) -> Result<Exam, AppError> {
    let row = sqlx::query_as::<_, (i64, String, DateTime<Utc>, DateTime<Utc>, ExamStatus, i32, i32)>(
        "select id, name, scheduled_start, scheduled_end, status, max_marks, passing_marks \
         from public.exams where id = $1 and deleted_at is null",
    )
    .bind(exam_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Exam not found".to_string()))?;

    Ok(Exam { id: row.0, name: row.1, scheduled_start: row.2, scheduled_end: row.3, status: row.4, max_marks: row.5, passing_marks: row.6 })
}

async fn load_attempt(pool: &PgPool, attempt_id: i64) -> Result<Attempt, AppError> {
    let sql = format!("select {ATTEMPT_COLUMNS} from public.assignments where id = $1 and deleted_at is null");
    let row = sqlx::query_as::<_, AttemptRow>(&sql)
        .bind(attempt_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Attempt not found".to_string()))?;
    Ok(attempt_from_row(row))
}

async fn load_own_attempt(pool: &PgPool, student_id: i64, attempt_id: i64) -> Result<(Attempt, Exam), AppError> {
    let attempt = load_attempt(pool, attempt_id).await?;
    if !access::owns_attempt(pool, attempt_id, student_id).await? {
        return Err(AppError::NotFound("Attempt not found".to_string()));
    }
    let exam = load_exam(pool, attempt.exam_id).await?;
    Ok((attempt, exam))
}

fn student_summary(attempt: &Attempt, exam: &Exam) -> AttemptSummary {
    let (score, passed, feedback) = if attempt.status == AttemptStatus::Graded {
        (Some(attempt.score), Some(attempt.score >= exam.passing_marks), attempt.feedback.clone())
    } else {
        (None, None, None)
    };

    AttemptSummary {
        id: attempt.id,
        exam_id: attempt.exam_id,
        status: student_status(attempt),
        started_at: attempt.started_at,
        submitted_at: attempt.submitted_at,
        auto_submitted: attempt.auto_submitted,
        session_duration: attempt.session_duration,
        session_duration_unit: attempt.session_duration_unit,
        expires_at: deadline_of(attempt, exam),
        remaining_seconds: remaining_seconds(attempt, exam),
        exam: AttemptExamBrief {
            id: exam.id,
            name: exam.name.clone(),
            scheduled_start: exam.scheduled_start,
            scheduled_end: exam.scheduled_end,
            status: exam.status,
            max_marks: exam.max_marks,
            passing_marks: exam.passing_marks,
        },
        score,
        passed,
        feedback,
    }
}

async fn attempt_questions(pool: &PgPool, attempt: &Attempt) -> Result<Vec<AttemptQuestion>, AppError> {
    let rows = sqlx::query_as::<_, (i64, i32, String, i32, TimeUnit, i32, i32, i32, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<DateTime<Utc>>, i32)>(
        "select question_id, position, answer, typing_duration, typing_duration_unit, text_typed, text_edited, \
         text_pasted, last_synced_at, started_at, answered_at, marks_awarded \
         from public.question_assignment where assignment_id = $1 order by position",
    )
    .bind(attempt.id)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(vec![]);
    }

    let question_ids: Vec<i64> = rows.iter().map(|row| row.0).collect();

    let questions = sqlx::query_as::<_, (i64, String, String, QuestionType, i32, TimeUnit)>(
        "select id, title, question, question_type, expected_duration, expected_duration_unit \
         from public.questions where id = any($1) and deleted_at is null",
    )
    .bind(&question_ids)
    .fetch_all(pool)
    .await?;
    let questions_by_id: HashMap<i64, _> = questions.into_iter().map(|q| (q.0, q)).collect();

    let options = sqlx::query_as::<_, (i64, i64, String)>(
        "select id, question_id, option_text from public.question_options \
         where question_id = any($1) and deleted_at is null order by id",
    )
    .bind(&question_ids)
    .fetch_all(pool)
    .await?;

    let chosen = sqlx::query_as::<_, (i64, i64)>(
        "select question_id, option_id from public.question_assignment_option where assignment_id = $1",
    )
    .bind(attempt.id)
    .fetch_all(pool)
    .await?;

    let marks = sqlx::query_as::<_, (i64, i32)>(
        "select question_id, marks from public.exam_question where exam_id = $1",
    )
    .bind(attempt.exam_id)
    .fetch_all(pool)
    .await?;
    let marks_by_question: HashMap<i64, i32> = marks.into_iter().collect();

    let graded = attempt.status == AttemptStatus::Graded;

    let mut result = Vec::with_capacity(rows.len());
    for (question_id, position, answer, typing_duration, typing_duration_unit, text_typed, text_edited, text_pasted, last_synced_at, started_at, answered_at, marks_awarded) in rows {
        // the question was soft deleted after the attempt started
        let Some(question) = questions_by_id.get(&question_id) else { continue };

        let question_options = options
            .iter()
            .filter(|option| option.1 == question_id)
            .map(|option| AttemptQuestionOption { id: option.0, option_text: option.2.clone() })
            .collect();
        let selected_option_ids = chosen.iter().filter(|c| c.0 == question_id).map(|c| c.1).collect();

        result.push(AttemptQuestion {
            question_id,
            position,
            title: question.1.clone(),
            question: question.2.clone(),
            question_type: question.3,
            expected_duration: question.4,
            expected_duration_unit: question.5,
            marks: marks_by_question.get(&question_id).copied().unwrap_or(0),
            options: question_options,
            answer,
            selected_option_ids,
            typing_duration,
            typing_duration_unit,
            text_typed,
            text_edited,
            text_pasted,
            started_at,
            answered_at,
            last_synced_at,
            marks_awarded: graded.then_some(marks_awarded),
        });
    }

    Ok(result)
}

async fn attempt_permitted_urls(pool: &PgPool, attempt_id: i64) -> Result<Vec<PermittedUrl>, AppError> {
    let rows = sqlx::query_as::<_, (i64, String)>(
        "select u.id, u.url from public.permitted_urls u \
         join public.assignment_permitted_url link on link.permitted_url_id = u.id \
         where link.assignment_id = $1",
    )
    .bind(attempt_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id, url)| PermittedUrl { id, url }).collect())
}

/// Closes an attempt: grades every objective answer all-or-nothing, stores the total, and
/// moves the status on. A flagged attempt keeps its status until a professor grades it (out
/// of scope this pass), so the flag is never silently lost.
async fn finish_attempt(pool: &PgPool, attempt: Attempt, exam: &Exam, auto: bool) -> Result<Attempt, AppError> {
    let mut tx = pool.begin().await?;

    let exam_questions = sqlx::query_as::<_, (i64, i32)>(
        "select question_id, marks from public.exam_question where exam_id = $1",
    )
    .bind(attempt.exam_id)
    .fetch_all(&mut *tx)
    .await?;
    let marks_by_question: HashMap<i64, i32> = exam_questions.iter().copied().collect();
    let question_ids: Vec<i64> = exam_questions.iter().map(|row| row.0).collect();

    let questions = if question_ids.is_empty() {
        vec![]
    } else {
        sqlx::query_as::<_, (i64, QuestionType)>(
            "select id, question_type from public.questions where id = any($1) and deleted_at is null",
        )
        .bind(&question_ids)
        .fetch_all(&mut *tx)
        .await?
    };
    let objective_ids: Vec<i64> = questions.iter().filter(|q| !q.1.is_manual()).map(|q| q.0).collect();
    let has_manual = questions.iter().any(|q| q.1.is_manual());

    let mut awarded: i32 = 0;
    if !objective_ids.is_empty() {
        let correct = sqlx::query_as::<_, (i64, i64)>(
            "select id, question_id from public.question_options \
             where question_id = any($1) and is_correct = true and deleted_at is null",
        )
        .bind(&objective_ids)
        .fetch_all(&mut *tx)
        .await?;
        let chosen = sqlx::query_as::<_, (i64, i64)>(
            "select question_id, option_id from public.question_assignment_option where assignment_id = $1",
        )
        .bind(attempt.id)
        .fetch_all(&mut *tx)
        .await?;

        for question_id in &objective_ids {
            let expected: HashSet<i64> = correct.iter().filter(|c| c.1 == *question_id).map(|c| c.0).collect();
            let given: HashSet<i64> = chosen.iter().filter(|c| c.0 == *question_id).map(|c| c.1).collect();
            // all or nothing on the option set; a question without a correct option can never be right
            let right = !expected.is_empty() && expected == given;
            let marks = if right { marks_by_question.get(question_id).copied().unwrap_or(0) } else { 0 };

            sqlx::query("update public.question_assignment set marks_awarded = $1 where assignment_id = $2 and question_id = $3")
                .bind(marks)
                .bind(attempt.id)
                .bind(question_id)
                .execute(&mut *tx)
                .await?;
            awarded += marks;
        }
    }

    let status = if attempt.status == AttemptStatus::Flagged {
        AttemptStatus::Flagged
    } else if has_manual {
        if auto { AttemptStatus::AutoSubmitted } else { AttemptStatus::Submitted }
    } else {
        AttemptStatus::Graded
    };
    let score = awarded.min(exam.max_marks);

    let sql = format!(
        "update public.assignments set submitted_at = now(), auto_submitted = $1, status = $2, score = $3 \
         where id = $4 returning {ATTEMPT_COLUMNS}"
    );
    let row = sqlx::query_as::<_, AttemptRow>(&sql)
        .bind(auto)
        .bind(status)
        .bind(score)
        .bind(attempt.id)
        .fetch_one(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(attempt_from_row(row))
}

// there is no cron: an attempt that ran out of time is closed by the next request that touches it
async fn ensure_current(pool: &PgPool, attempt: Attempt, exam: &Exam) -> Result<Attempt, AppError> {
    if is_open(&attempt) && Utc::now() >= deadline_of(&attempt, exam) {
        finish_attempt(pool, attempt, exam, true).await
    } else {
        Ok(attempt)
    }
}

const STARTABLE_STATUSES: [ExamStatus; 3] = [ExamStatus::Scheduled, ExamStatus::Ongoing, ExamStatus::Demo];

/// `POST /api/attempts`. Reuses the already-deployed `start_attempt` Postgres function
/// (`migrations/008_start_attempt.sql`) for the four writes that have to succeed together;
/// the cheap checks (schedule, status, enrolment, one attempt per student) stay here, same
/// split as the TS `startAttempt`.
pub async fn start_attempt(pool: &PgPool, student_id: i64, exam_id: i64) -> Result<AttemptDetail, AppError> {
    let exam = load_exam(pool, exam_id).await?;
    if !access::sits_exam(pool, exam_id, student_id).await? {
        return Err(AppError::NotFound("Exam not found".to_string()));
    }
    if !STARTABLE_STATUSES.contains(&exam.status) {
        return Err(AppError::BadRequest(format!("This exam is {} and cannot be taken", exam.status)));
    }

    let now = Utc::now();
    if now < exam.scheduled_start {
        return Err(AppError::BadRequest("This exam has not started yet".to_string()));
    }
    if now >= exam.scheduled_end {
        return Err(AppError::BadRequest("This exam is over".to_string()));
    }

    // one attempt per student per exam is a unique constraint; checking first avoids
    // creating a row for nothing, same as the TS version
    let existing = sqlx::query_scalar::<_, i64>(
        "select assignment_id from public.student_assignment where student_id = $1 and exam_id = $2",
    )
    .bind(student_id)
    .bind(exam_id)
    .fetch_optional(pool)
    .await?;
    if existing.is_some() {
        return Err(AppError::Conflict("You have already started this exam".to_string()));
    }

    let exam_question_ids = sqlx::query_scalar::<_, i64>(
        "select question_id from public.exam_question where exam_id = $1",
    )
    .bind(exam_id)
    .fetch_all(pool)
    .await?;
    let questions = if exam_question_ids.is_empty() {
        vec![]
    } else {
        sqlx::query_as::<_, (i32, TimeUnit)>(
            "select expected_duration, expected_duration_unit from public.questions \
             where id = any($1) and deleted_at is null",
        )
        .bind(&exam_question_ids)
        .fetch_all(pool)
        .await?
    };
    if questions.is_empty() {
        return Err(AppError::BadRequest("This exam has no questions yet".to_string()));
    }

    let window_left = (exam.scheduled_end - now).num_seconds().max(0);
    let expected: i64 = questions.iter().map(|(duration, unit)| unit.to_seconds(*duration)).sum();
    let base = if expected == 0 { window_left } else { expected };
    let session_duration = base.min(window_left);

    // the attempt, its student link, its questions in their attempt order and the permitted
    // urls are one transaction in the database: a half started attempt is unusable
    let created: serde_json::Value = sqlx::query_scalar(
        "select public.start_attempt($1, $2, $3, $4)",
    )
    .bind(student_id)
    .bind(exam_id)
    .bind(session_duration as i32)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(|err| map_unique_violation(err, "You have already started this exam"))?;

    let row: StartedAttemptRow = serde_json::from_value(created).map_err(|err| AppError::Internal(err.into()))?;
    let attempt = Attempt::from(row);

    Ok(AttemptDetail {
        summary: student_summary(&attempt, &exam),
        questions: attempt_questions(pool, &attempt).await?,
        permitted_urls: attempt_permitted_urls(pool, attempt.id).await?,
    })
}

/// `GET /api/attempts/:id`.
pub async fn get_attempt(pool: &PgPool, student_id: i64, attempt_id: i64) -> Result<AttemptDetail, AppError> {
    let (attempt, exam) = load_own_attempt(pool, student_id, attempt_id).await?;
    let current = ensure_current(pool, attempt, &exam).await?;

    Ok(AttemptDetail {
        summary: student_summary(&current, &exam),
        questions: attempt_questions(pool, &current).await?,
        permitted_urls: attempt_permitted_urls(pool, current.id).await?,
    })
}

fn require_non_negative(value: i32, field: &str) -> Result<i32, AppError> {
    if value < 0 {
        return Err(AppError::BadRequest(format!("{field} must be a whole number of zero or more")));
    }
    Ok(value)
}

/// `PUT /api/attempts/:id/answers`. Validates the whole batch before writing anything.
pub async fn sync_answers(
    pool: &PgPool,
    student_id: i64,
    attempt_id: i64,
    answers: Vec<AnswerInput>,
) -> Result<SyncAnswersResponse, AppError> {
    let (attempt, exam) = load_own_attempt(pool, student_id, attempt_id).await?;
    let current = ensure_current(pool, attempt, &exam).await?;
    if !is_open(&current) {
        let message = if current.auto_submitted {
            "Time is up: this attempt has been submitted automatically"
        } else {
            "This attempt is not in progress"
        };
        return Err(AppError::Conflict(message.to_string()));
    }
    if answers.is_empty() {
        return Err(AppError::BadRequest("answers must be a non-empty array".to_string()));
    }

    let asked: HashSet<i64> = sqlx::query_scalar::<_, i64>(
        "select question_id from public.question_assignment where assignment_id = $1",
    )
    .bind(current.id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();

    for answer in &answers {
        if !asked.contains(&answer.question_id) {
            return Err(AppError::BadRequest(format!("Question {} is not part of this attempt", answer.question_id)));
        }
        if let Some(value) = answer.typing_duration {
            require_non_negative(value, "typingDuration")?;
        }
        if let Some(value) = answer.text_typed {
            require_non_negative(value, "textTyped")?;
        }
        if let Some(value) = answer.text_edited {
            require_non_negative(value, "textEdited")?;
        }
        if let Some(value) = answer.text_pasted {
            require_non_negative(value, "textPasted")?;
        }
    }

    // every chosen option has to belong to the question it was sent for
    let all_option_ids: Vec<i64> = answers.iter().flat_map(|answer| answer.option_ids.clone().unwrap_or_default()).collect();
    if !all_option_ids.is_empty() {
        let owners = sqlx::query_as::<_, (i64, i64)>(
            "select id, question_id from public.question_options where id = any($1) and deleted_at is null",
        )
        .bind(&all_option_ids)
        .fetch_all(pool)
        .await?;
        let question_by_option: HashMap<i64, i64> = owners.into_iter().collect();

        for answer in &answers {
            for option_id in answer.option_ids.iter().flatten() {
                if question_by_option.get(option_id) != Some(&answer.question_id) {
                    return Err(AppError::BadRequest(format!(
                        "Option {option_id} does not belong to question {}",
                        answer.question_id
                    )));
                }
            }
        }
    }

    let mut tx = pool.begin().await?;
    let synced = answers.len();
    for answer in answers {
        let mut builder = sqlx::QueryBuilder::new("update public.question_assignment set last_synced_at = now()");
        if let Some(text) = &answer.answer {
            builder.push(", answer = ").push_bind(text.clone());
        }
        if let Some(value) = answer.typing_duration {
            builder.push(", typing_duration = ").push_bind(value);
        }
        if let Some(unit) = answer.typing_duration_unit {
            builder.push(", typing_duration_unit = ").push_bind(unit);
        }
        if let Some(value) = answer.text_typed {
            builder.push(", text_typed = ").push_bind(value);
        }
        if let Some(value) = answer.text_edited {
            builder.push(", text_edited = ").push_bind(value);
        }
        if let Some(value) = answer.text_pasted {
            builder.push(", text_pasted = ").push_bind(value);
        }
        if let Some(started_at) = answer.started_at {
            builder.push(", started_at = ").push_bind(started_at);
        }
        let answered_at = answer.answered_at.or_else(|| {
            if answer.answer.is_some() || answer.option_ids.is_some() { Some(Utc::now()) } else { None }
        });
        if let Some(answered_at) = answered_at {
            builder.push(", answered_at = ").push_bind(answered_at);
        }
        builder.push(" where assignment_id = ").push_bind(current.id);
        builder.push(" and question_id = ").push_bind(answer.question_id);
        builder.build().execute(&mut *tx).await?;

        if let Some(option_ids) = answer.option_ids {
            sqlx::query("delete from public.question_assignment_option where assignment_id = $1 and question_id = $2")
                .bind(current.id)
                .bind(answer.question_id)
                .execute(&mut *tx)
                .await?;

            for option_id in option_ids {
                sqlx::query(
                    "insert into public.question_assignment_option (assignment_id, question_id, option_id) \
                     values ($1, $2, $3)",
                )
                .bind(current.id)
                .bind(answer.question_id)
                .bind(option_id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    tx.commit().await?;

    Ok(SyncAnswersResponse { synced, remaining_seconds: remaining_seconds(&current, &exam) })
}

/// `POST /api/attempts/:id/submit`.
pub async fn submit_attempt(pool: &PgPool, student_id: i64, attempt_id: i64) -> Result<SubmitResponse, AppError> {
    let (attempt, exam) = load_own_attempt(pool, student_id, attempt_id).await?;
    if !is_open(&attempt) {
        return Err(AppError::Conflict("This attempt has already been submitted".to_string()));
    }

    let auto = Utc::now() >= deadline_of(&attempt, &exam);
    let submitted = finish_attempt(pool, attempt, &exam, auto).await?;

    let message = if auto {
        "Time was up: this attempt has been submitted automatically"
    } else {
        "Your answers have been submitted"
    };
    Ok(SubmitResponse { attempt: student_summary(&submitted, &exam), message: message.to_string() })
}

#[cfg(test)]
mod tests {
    use super::StartedAttemptRow;

    // `start_attempt` hands back `to_json(new_attempt)` - a Postgres row cast straight to
    // json, i.e. an object keyed by column name. Deserializing that into a plain tuple (as
    // this used to) fails every time: serde reads a tuple from a JSON array, never an object.
    #[test]
    fn deserializes_start_attempt_json_object() {
        let json = serde_json::json!({
            "id": 42,
            "exam_id": 7,
            "session_duration": 3600,
            "session_duration_unit": "seconds",
            "started_at": "2026-01-01T09:00:00+00:00",
            "submitted_at": null,
            "auto_submitted": false,
            "status": "in_progress",
            "score": 0,
            "created_at": "2026-01-01T09:00:00+00:00",
            "updated_at": "2026-01-01T09:00:00+00:00",
            "deleted_at": null,
            "reason": null,
            "feedback": null
        });

        let row: StartedAttemptRow = serde_json::from_value(json).expect("start_attempt's json object should deserialize");
        assert_eq!(row.id, 42);
        assert_eq!(row.exam_id, 7);
        assert_eq!(row.session_duration, 3600);
    }
}
