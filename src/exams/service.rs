//! Student read-only exam access. Ports the student half of `exam.service.ts`'s `listExams`/
//! `getExam`, using `exam_student` (`lib/exam-access.ts`'s `sitsExam`) as the visibility rule.

use sqlx::PgPool;

use crate::error::AppError;
use crate::exams::models::{ExamDetail, ExamStatus, ExamSummary, PermittedUrl};

type ExamRow = (i64, String, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>, ExamStatus, i32, i32);

fn to_summary(row: ExamRow) -> ExamSummary {
    ExamSummary {
        id: row.0,
        name: row.1,
        scheduled_start: row.2,
        scheduled_end: row.3,
        status: row.4,
        max_marks: row.5,
        passing_marks: row.6,
    }
}

/// Exams `student_id` is assigned to sit, live ones only, oldest scheduled first.
pub async fn list_exams(pool: &PgPool, student_id: i64) -> Result<Vec<ExamSummary>, AppError> {
    let rows = sqlx::query_as::<_, ExamRow>(
        "select e.id, e.name, e.scheduled_start, e.scheduled_end, e.status, e.max_marks, e.passing_marks \
         from public.exams e \
         join public.exam_student es on es.exam_id = e.id \
         where es.student_id = $1 and e.deleted_at is null \
         order by e.scheduled_start",
    )
    .bind(student_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(to_summary).collect())
}

async fn permitted_urls(pool: &PgPool, exam_id: i64) -> Result<Vec<PermittedUrl>, AppError> {
    let rows = sqlx::query_as::<_, (i64, String)>(
        "select u.id, u.url from public.permitted_urls u \
         join public.exam_permitted_url link on link.permitted_url_id = u.id \
         where link.exam_id = $1 \
         order by u.url",
    )
    .bind(exam_id)
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(|(id, url)| PermittedUrl { id, url }).collect())
}

/// One exam as `student_id` may see it - 404 both when it doesn't exist and when the
/// student isn't assigned to it, so the two are indistinguishable from outside.
pub async fn get_exam(pool: &PgPool, student_id: i64, exam_id: i64) -> Result<ExamDetail, AppError> {
    let row = sqlx::query_as::<_, ExamRow>(
        "select e.id, e.name, e.scheduled_start, e.scheduled_end, e.status, e.max_marks, e.passing_marks \
         from public.exams e \
         join public.exam_student es on es.exam_id = e.id \
         where e.id = $1 and es.student_id = $2 and e.deleted_at is null",
    )
    .bind(exam_id)
    .bind(student_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Exam not found".to_string()))?;

    let permitted_urls = permitted_urls(pool, exam_id).await?;
    Ok(ExamDetail { exam: to_summary(row), permitted_urls })
}
