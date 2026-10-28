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
    AttemptSummary, QuestionType, SubmitResponse, SyncAnswersResponse, UploadAnswerFileResponse,
};
use crate::config::Config;
use crate::deadline::{deadline, TimeUnit, Window};
use crate::error::{map_unique_violation, AppError};
use crate::exams::models::{ExamStatus, PermittedUrl};
use crate::storage;

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

type ExamRow = (i64, String, DateTime<Utc>, DateTime<Utc>, ExamStatus, i32, i32);

fn exam_from_row(row: ExamRow) -> Exam {
    Exam { id: row.0, name: row.1, scheduled_start: row.2, scheduled_end: row.3, status: row.4, max_marks: row.5, passing_marks: row.6 }
}

async fn load_exam(pool: &PgPool, exam_id: i64) -> Result<Exam, AppError> {
    let row = sqlx::query_as::<_, ExamRow>(
        "select id, name, scheduled_start, scheduled_end, status, max_marks, passing_marks \
         from public.exams where id = $1 and deleted_at is null",
    )
    .bind(exam_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Exam not found".to_string()))?;

    Ok(exam_from_row(row))
}

/// The exam of `attempt_id`, but only when `student_id` owns that attempt: the ownership check
/// and the exam lookup in one round trip.
async fn owned_exam(pool: &PgPool, attempt_id: i64, student_id: i64) -> Result<Option<Exam>, AppError> {
    let row = sqlx::query_as::<_, ExamRow>(
        "select e.id, e.name, e.scheduled_start, e.scheduled_end, e.status, e.max_marks, e.passing_marks \
         from public.exams e join public.student_assignment sa on sa.exam_id = e.id \
         where sa.assignment_id = $1 and sa.student_id = $2 and e.deleted_at is null",
    )
    .bind(attempt_id)
    .bind(student_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(exam_from_row))
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
    let (attempt, exam) = tokio::try_join!(load_attempt(pool, attempt_id), owned_exam(pool, attempt_id, student_id))?;
    let exam = exam.ok_or_else(|| AppError::NotFound("Attempt not found".to_string()))?;
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
    // The database is far away, so every query in a row costs a round trip. All of these hang off
    // the assignment id, so they go out together.
    let (rows, chosen, marks, questions, options) = tokio::try_join!(
        sqlx::query_as::<_, (i64, i32, String, i32, TimeUnit, i32, i32, i32, Option<DateTime<Utc>>, Option<DateTime<Utc>>, Option<DateTime<Utc>>, i32)>(
            "select question_id, position, answer, typing_duration, typing_duration_unit, text_typed, text_edited, \
             text_pasted, last_synced_at, started_at, answered_at, marks_awarded \
             from public.question_assignment where assignment_id = $1 order by position",
        )
        .bind(attempt.id)
        .fetch_all(pool),
        sqlx::query_as::<_, (i64, i64)>(
            "select question_id, option_id from public.question_assignment_option where assignment_id = $1",
        )
        .bind(attempt.id)
        .fetch_all(pool),
        sqlx::query_as::<_, (i64, i32)>("select question_id, marks from public.exam_question where exam_id = $1")
            .bind(attempt.exam_id)
            .fetch_all(pool),
        sqlx::query_as::<_, (i64, String, String, QuestionType, i32, TimeUnit)>(
            "select q.id, q.title, q.question, q.question_type, q.expected_duration, q.expected_duration_unit \
             from public.questions q join public.question_assignment qa on qa.question_id = q.id \
             where qa.assignment_id = $1 and q.deleted_at is null",
        )
        .bind(attempt.id)
        .fetch_all(pool),
        sqlx::query_as::<_, (i64, i64, String)>(
            "select o.id, o.question_id, o.option_text from public.question_options o \
             join public.question_assignment qa on qa.question_id = o.question_id \
             where qa.assignment_id = $1 and o.deleted_at is null order by o.id",
        )
        .bind(attempt.id)
        .fetch_all(pool),
    )?;
    let marks_by_question: HashMap<i64, i32> = marks.into_iter().collect();
    let questions_by_id: HashMap<i64, _> = questions.into_iter().map(|q| (q.0, q)).collect();

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
    // Grading only needs what is already stored, so the reads go out together...
    let (questions, correct, chosen) = tokio::try_join!(
        sqlx::query_as::<_, (i64, i32, QuestionType)>(
            "select eq.question_id, eq.marks, q.question_type from public.exam_question eq \
             join public.questions q on q.id = eq.question_id where eq.exam_id = $1 and q.deleted_at is null",
        )
        .bind(attempt.exam_id)
        .fetch_all(pool),
        sqlx::query_as::<_, (i64, i64)>(
            "select o.id, o.question_id from public.question_options o \
             join public.exam_question eq on eq.question_id = o.question_id \
             where eq.exam_id = $1 and o.is_correct = true and o.deleted_at is null",
        )
        .bind(attempt.exam_id)
        .fetch_all(pool),
        sqlx::query_as::<_, (i64, i64)>(
            "select question_id, option_id from public.question_assignment_option where assignment_id = $1",
        )
        .bind(attempt.id)
        .fetch_all(pool),
    )?;
    let has_manual = questions.iter().any(|q| q.2.is_manual());

    let mut graded_ids: Vec<i64> = Vec::new();
    let mut graded_marks: Vec<i32> = Vec::new();
    let mut awarded: i32 = 0;
    for (question_id, marks, _) in questions.iter().filter(|q| !q.2.is_manual()) {
        let expected: HashSet<i64> = correct.iter().filter(|c| c.1 == *question_id).map(|c| c.0).collect();
        let given: HashSet<i64> = chosen.iter().filter(|c| c.0 == *question_id).map(|c| c.1).collect();
        // all or nothing on the option set; a question without a correct option can never be right
        let right = !expected.is_empty() && expected == given;
        let earned = if right { *marks } else { 0 };
        graded_ids.push(*question_id);
        graded_marks.push(earned);
        awarded += earned;
    }

    let status = if attempt.status == AttemptStatus::Flagged {
        AttemptStatus::Flagged
    } else if has_manual {
        if auto { AttemptStatus::AutoSubmitted } else { AttemptStatus::Submitted }
    } else {
        AttemptStatus::Graded
    };
    let score = awarded.min(exam.max_marks);

    // ...and the marks plus the closing of the attempt are one statement, so they land together
    // without a transaction's extra round trips.
    let sql = format!(
        "with awarded as ( \
             update public.question_assignment qa set marks_awarded = m.marks \
             from unnest($1::bigint[], $2::int[]) as m(question_id, marks) \
             where qa.assignment_id = $3::bigint and qa.question_id = m.question_id \
             returning 1 \
         ) \
         update public.assignments set submitted_at = now(), auto_submitted = $4, status = $5, score = $6 \
         where id = $3::bigint returning {ATTEMPT_COLUMNS}"
    );
    let row = sqlx::query_as::<_, AttemptRow>(&sql)
        .bind(&graded_ids)
        .bind(&graded_marks)
        .bind(attempt.id)
        .bind(auto)
        .bind(status)
        .bind(score)
        .fetch_one(pool)
        .await?;

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
    // These reads don't depend on each other; the checks below still run in the same order.
    let (exam, sits, existing, durations) = tokio::try_join!(
        load_exam(pool, exam_id),
        access::sits_exam(pool, exam_id, student_id),
        // one attempt per student per exam is a unique constraint; checking first avoids
        // creating a row for nothing, same as the TS version
        async {
            sqlx::query_scalar::<_, i64>(
                "select assignment_id from public.student_assignment where student_id = $1 and exam_id = $2",
            )
            .bind(student_id)
            .bind(exam_id)
            .fetch_optional(pool)
            .await
            .map_err(AppError::from)
        },
        async {
            sqlx::query_as::<_, (i32, TimeUnit)>(
                "select q.expected_duration, q.expected_duration_unit from public.questions q \
                 join public.exam_question eq on eq.question_id = q.id \
                 where eq.exam_id = $1 and q.deleted_at is null",
            )
            .bind(exam_id)
            .fetch_all(pool)
            .await
            .map_err(AppError::from)
        },
    )?;
    if !sits {
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
    if let Some(attempt_id) = existing {
        return resume_attempt(pool, student_id, attempt_id).await;
    }
    if durations.is_empty() {
        return Err(AppError::BadRequest("This exam has no questions yet".to_string()));
    }

    let window_left = (exam.scheduled_end - now).num_seconds().max(0);
    let expected: i64 = durations.iter().map(|(duration, unit)| unit.to_seconds(*duration)).sum();
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

    attempt_detail(pool, &attempt, &exam).await}

/// `GET /api/attempts/my` - every attempt this student has, most recent first. Mirrors the TS
/// `listMyAttempts`: only attempts that actually exist (started), an exam with no attempt yet
/// doesn't show up here - that's what `GET /api/exams`'s `attempt_status: None` already covers.
pub async fn list_my_attempts(pool: &PgPool, student_id: i64) -> Result<Vec<AttemptSummary>, AppError> {
    let links = sqlx::query_scalar::<_, i64>(
        "select assignment_id from public.student_assignment where student_id = $1",
    )
    .bind(student_id)
    .fetch_all(pool)
    .await?;
    if links.is_empty() {
        return Ok(Vec::new());
    }

    let sql = format!(
        "select {ATTEMPT_COLUMNS} from public.assignments where id = any($1) and deleted_at is null order by id desc"
    );
    let attempts: Vec<Attempt> = sqlx::query_as::<_, AttemptRow>(&sql)
        .bind(&links)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(attempt_from_row)
        .collect();
    if attempts.is_empty() {
        return Ok(Vec::new());
    }

    let exam_ids: Vec<i64> = attempts.iter().map(|a| a.exam_id).collect();
    let exams_by_id: HashMap<i64, Exam> = sqlx::query_as::<_, ExamRow>(
        "select id, name, scheduled_start, scheduled_end, status, max_marks, passing_marks \
         from public.exams where id = any($1) and deleted_at is null",
    )
    .bind(&exam_ids)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|row| {
        let exam = exam_from_row(row);
        (exam.id, exam)
    })
    .collect();

    Ok(attempts.iter().filter_map(|a| exams_by_id.get(&a.exam_id).map(|exam| student_summary(a, exam))).collect())
}

/// `GET /api/attempts/:id`.
pub async fn get_attempt(pool: &PgPool, student_id: i64, attempt_id: i64) -> Result<AttemptDetail, AppError> {
    let (attempt, exam) = load_own_attempt(pool, student_id, attempt_id).await?;
    let current = ensure_current(pool, attempt, &exam).await?;
    attempt_detail(pool, &current, &exam).await
}

async fn attempt_detail(pool: &PgPool, attempt: &Attempt, exam: &Exam) -> Result<AttemptDetail, AppError> {
    let (questions, permitted_urls) =
        tokio::try_join!(attempt_questions(pool, attempt), attempt_permitted_urls(pool, attempt.id))?;
    Ok(AttemptDetail { summary: student_summary(attempt, exam), questions, permitted_urls })
}

/// Starting an exam whose attempt is still open picks that attempt up where it was left (the app
/// was closed, the connection dropped). A finished attempt can't be started again.
async fn resume_attempt(pool: &PgPool, student_id: i64, attempt_id: i64) -> Result<AttemptDetail, AppError> {
    let (attempt, exam) = load_own_attempt(pool, student_id, attempt_id).await?;
    let current = ensure_current(pool, attempt, &exam).await?;
    if !is_open(&current) {
        return Err(AppError::Conflict("You have already completed this exam".to_string()));
    }
    attempt_detail(pool, &current, &exam).await
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
    let all_option_ids: Vec<i64> = answers.iter().flat_map(|answer| answer.option_ids.clone().unwrap_or_default()).collect();

    // The database is far away, so these reads go out together; the checks below still run in
    // the order they would have if the reads had been made one after another.
    let ((attempt, exam), asked, owners) = tokio::try_join!(
        load_own_attempt(pool, student_id, attempt_id),
        async {
            sqlx::query_scalar::<_, i64>("select question_id from public.question_assignment where assignment_id = $1")
                .bind(attempt_id)
                .fetch_all(pool)
                .await
                .map_err(AppError::from)
        },
        async {
            if all_option_ids.is_empty() {
                return Ok(Vec::new());
            }
            sqlx::query_as::<_, (i64, i64)>(
                "select id, question_id from public.question_options where id = any($1) and deleted_at is null",
            )
            .bind(&all_option_ids)
            .fetch_all(pool)
            .await
            .map_err(AppError::from)
        },
    )?;
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

    let asked: HashSet<i64> = asked.into_iter().collect();
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

    let synced = answers.len();
    let question_ids: Vec<i64> = answers.iter().map(|a| a.question_id).collect();
    let texts: Vec<Option<String>> = answers.iter().map(|a| a.answer.clone()).collect();
    let typing: Vec<Option<i32>> = answers.iter().map(|a| a.typing_duration).collect();
    let units: Vec<Option<String>> = answers.iter().map(|a| a.typing_duration_unit.map(|u| u.as_str().to_string())).collect();
    let typed: Vec<Option<i32>> = answers.iter().map(|a| a.text_typed).collect();
    let edited: Vec<Option<i32>> = answers.iter().map(|a| a.text_edited).collect();
    let pasted: Vec<Option<i32>> = answers.iter().map(|a| a.text_pasted).collect();
    let started: Vec<Option<DateTime<Utc>>> = answers.iter().map(|a| a.started_at).collect();
    let answered: Vec<Option<DateTime<Utc>>> = answers.iter().map(|a| a.answered_at).collect();
    let has_content: Vec<bool> = answers.iter().map(|a| a.answer.is_some() || a.option_ids.is_some()).collect();
    let mut wanted_questions: Vec<i64> = Vec::new();
    let mut wanted_options: Vec<i64> = Vec::new();
    for answer in &answers {
        for option_id in answer.option_ids.iter().flatten() {
            wanted_questions.push(answer.question_id);
            wanted_options.push(*option_id);
        }
    }
    let touched: Vec<i64> = answers.iter().filter(|a| a.option_ids.is_some()).map(|a| a.question_id).collect();

    // One statement for the whole batch, so it is atomic and costs one round trip however many
    // questions it carries. Chosen options are brought in line by removing the ones no longer
    // wanted and adding the missing ones, which keeps the two sub-statements from touching the
    // same rows.
    sqlx::query(
        "with incoming as ( \
             select v.question_id, v.answer, v.typing_duration, \
                    v.typing_duration_unit::public.type_time_unit as typing_duration_unit, \
                    v.text_typed, v.text_edited, v.text_pasted, v.started_at, v.answered_at, v.has_content \
             from unnest($2::bigint[], $3::text[], $4::int[], $5::text[], $6::int[], $7::int[], $8::int[], \
                         $9::timestamptz[], $10::timestamptz[], $11::bool[]) \
                  as v(question_id, answer, typing_duration, typing_duration_unit, text_typed, text_edited, \
                       text_pasted, started_at, answered_at, has_content) \
         ), \
         wanted as ( \
             select distinct w.question_id, w.option_id from unnest($12::bigint[], $13::bigint[]) as w(question_id, option_id) \
         ), \
         removed as ( \
             delete from public.question_assignment_option o \
             where o.assignment_id = $1::bigint and o.question_id = any($14::bigint[]) \
               and not exists (select 1 from wanted w where w.question_id = o.question_id and w.option_id = o.option_id) \
             returning 1 \
         ), \
         added as ( \
             insert into public.question_assignment_option (assignment_id, question_id, option_id) \
             select $1::bigint, w.question_id, w.option_id from wanted w \
             where not exists (select 1 from public.question_assignment_option o \
                               where o.assignment_id = $1::bigint and o.question_id = w.question_id and o.option_id = w.option_id) \
             returning 1 \
         ) \
         update public.question_assignment qa set \
             last_synced_at = now(), \
             answer = coalesce(v.answer, qa.answer), \
             typing_duration = coalesce(v.typing_duration, qa.typing_duration), \
             typing_duration_unit = coalesce(v.typing_duration_unit, qa.typing_duration_unit), \
             text_typed = coalesce(v.text_typed, qa.text_typed), \
             text_edited = coalesce(v.text_edited, qa.text_edited), \
             text_pasted = coalesce(v.text_pasted, qa.text_pasted), \
             started_at = coalesce(v.started_at, qa.started_at), \
             answered_at = coalesce(v.answered_at, case when v.has_content then now() end, qa.answered_at) \
         from incoming v \
         where qa.assignment_id = $1::bigint and qa.question_id = v.question_id",
    )
    .bind(current.id)
    .bind(&question_ids)
    .bind(&texts)
    .bind(&typing)
    .bind(&units)
    .bind(&typed)
    .bind(&edited)
    .bind(&pasted)
    .bind(&started)
    .bind(&answered)
    .bind(&has_content)
    .bind(&wanted_questions)
    .bind(&wanted_options)
    .bind(&touched)
    .execute(pool)
    .await?;

    Ok(SyncAnswersResponse { synced, remaining_seconds: remaining_seconds(&current, &exam) })
}

/// `POST /api/attempts/:id/file`. A `file_upload` question is answered by uploading a file
/// instead of typing - the file's public URL becomes the answer, same column every other
/// question type already writes to.
pub async fn upload_answer_file(
    pool: &PgPool,
    config: &Config,
    student_id: i64,
    attempt_id: i64,
    question_id: i64,
    file_name: &str,
    file_data: &str,
) -> Result<UploadAnswerFileResponse, AppError> {
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

    let question_type: Option<QuestionType> = sqlx::query_scalar(
        "select q.question_type from public.question_assignment qa \
         join public.questions q on q.id = qa.question_id \
         where qa.assignment_id = $1 and qa.question_id = $2",
    )
    .bind(current.id)
    .bind(question_id)
    .fetch_optional(pool)
    .await?;

    match question_type {
        None => return Err(AppError::BadRequest(format!("Question {question_id} is not part of this attempt"))),
        Some(QuestionType::FileUpload) => {}
        Some(_) => return Err(AppError::BadRequest("This question does not accept a file".to_string())),
    }

    let url = storage::upload_submission_file(config, current.id, question_id, file_name, file_data).await?;

    sqlx::query(
        "update public.question_assignment set answer = $3, answered_at = now(), last_synced_at = now() \
         where assignment_id = $1 and question_id = $2",
    )
    .bind(current.id)
    .bind(question_id)
    .bind(&url)
    .execute(pool)
    .await?;

    Ok(UploadAnswerFileResponse { url, remaining_seconds: remaining_seconds(&current, &exam) })
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
