//! End-to-end attempts flow against the real (live) database: seeds a throwaway exam and
//! student directly with SQL (there's no professor-authoring endpoint in this student-only
//! backend to create one through), then drives start/sync/submit through the actual service
//! functions - the same code path `POST /api/attempts` etc. call. Everything it creates is
//! deleted at the end, success or failure.
//!
//! Needs `DATABASE_URL` (see `crates/magi-server/.env`); skips itself if unset so `cargo test
//! -p magi-server` still passes with no database configured.

use chrono::{Duration, Utc};
use magi_server::attempts::models::{AnswerInput, AttemptStatus};
use magi_server::attempts::service;
use magi_server::auth::password;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

struct Fixture {
    user_id: i64,
    exam_id: i64,
    question_ids: [i64; 2],
    option_ids: [i64; 2],
}

async fn seed(pool: &PgPool) -> Fixture {
    let tag = format!("rust-port-test-{}", Utc::now().timestamp_nanos_opt().unwrap());
    let email = format!("{tag}@example.invalid");
    let hashed = password::hash("Test1234!").unwrap();

    let user_id: i64 = sqlx::query_scalar(
        "insert into public.users (first_name, last_name, email, password, is_verified, active_status) \
         values ($1, 'Tester', $2, $3, true, 'active') returning id",
    )
    .bind(&tag)
    .bind(&email)
    .bind(&hashed)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("insert into public.students (user_id) values ($1)").bind(user_id).execute(pool).await.unwrap();

    let now = Utc::now();
    let exam_id: i64 = sqlx::query_scalar(
        "insert into public.exams (name, shuffle_questions, scheduled_start, scheduled_end, status, max_marks, passing_marks) \
         values ($1, false, $2, $3, 'scheduled', 10, 5) returning id",
    )
    .bind(&tag)
    .bind(now - Duration::minutes(1))
    .bind(now + Duration::hours(1))
    .fetch_one(pool)
    .await
    .unwrap();

    let mut question_ids = [0i64; 2];
    let mut option_ids = [0i64; 2];
    for i in 0..2 {
        let question_id: i64 = sqlx::query_scalar(
            "insert into public.questions (title, question_type, question, expected_duration, expected_duration_unit) \
             values ($1, 'multiple_choice', 'Is this a test?', 60, 'seconds') returning id",
        )
        .bind(format!("{tag}-q{i}"))
        .fetch_one(pool)
        .await
        .unwrap();
        question_ids[i] = question_id;

        let correct_option_id: i64 = sqlx::query_scalar(
            "insert into public.question_options (question_id, option_text, is_correct) values ($1, 'Yes', true) returning id",
        )
        .bind(question_id)
        .fetch_one(pool)
        .await
        .unwrap();
        sqlx::query("insert into public.question_options (question_id, option_text, is_correct) values ($1, 'No', false)")
            .bind(question_id)
            .execute(pool)
            .await
            .unwrap();
        option_ids[i] = correct_option_id;

        sqlx::query("insert into public.exam_question (exam_id, question_id, position, marks) values ($1, $2, $3, 5)")
            .bind(exam_id)
            .bind(question_id)
            .bind(i as i32)
            .execute(pool)
            .await
            .unwrap();
    }

    sqlx::query("insert into public.exam_student (exam_id, student_id) values ($1, $2)")
        .bind(exam_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();

    Fixture { user_id, exam_id, question_ids, option_ids }
}

async fn cleanup(pool: &PgPool, fixture: &Fixture) {
    // assignments cascade into question_assignment(_option)/student_assignment/cheating_reason/etc.
    sqlx::query("delete from public.assignments where exam_id = $1").bind(fixture.exam_id).execute(pool).await.ok();
    sqlx::query("delete from public.exam_student where exam_id = $1").bind(fixture.exam_id).execute(pool).await.ok();
    sqlx::query("delete from public.exam_question where exam_id = $1").bind(fixture.exam_id).execute(pool).await.ok();
    for question_id in fixture.question_ids {
        sqlx::query("delete from public.question_options where question_id = $1").bind(question_id).execute(pool).await.ok();
        sqlx::query("delete from public.questions where id = $1").bind(question_id).execute(pool).await.ok();
    }
    sqlx::query("delete from public.exams where id = $1").bind(fixture.exam_id).execute(pool).await.ok();
    sqlx::query("delete from public.students where user_id = $1").bind(fixture.user_id).execute(pool).await.ok();
    sqlx::query("delete from public.users where id = $1").bind(fixture.user_id).execute(pool).await.ok();
}

#[tokio::test]
async fn start_sync_submit_grades_correctly() {
    let _ = dotenvy::dotenv();
    let Ok(database_url) = std::env::var("DATABASE_URL") else {
        eprintln!("skipping: DATABASE_URL not set");
        return;
    };
    let pool = PgPoolOptions::new().max_connections(3).connect(&database_url).await.unwrap();

    let fixture = seed(&pool).await;

    let result = async {
        let started = service::start_attempt(&pool, fixture.user_id, fixture.exam_id).await?;
        assert_eq!(started.summary.status, AttemptStatus::InProgress);
        assert_eq!(started.questions.len(), 2);
        assert!(started.summary.remaining_seconds > 0, "a freshly started attempt must have time left");

        let attempt_id = started.summary.id;

        // answer the first question correctly, the second wrongly (leave it unanswered ->
        // no selected option -> graded wrong, since a question with no chosen option can
        // never match a non-empty correct set)
        let answers = vec![AnswerInput {
            question_id: fixture.question_ids[0],
            answer: None,
            option_ids: Some(vec![fixture.option_ids[0]]),
            typing_duration: None,
            typing_duration_unit: None,
            text_typed: None,
            text_edited: None,
            text_pasted: None,
            started_at: None,
            answered_at: None,
        }];
        let synced = service::sync_answers(&pool, fixture.user_id, attempt_id, answers).await?;
        assert_eq!(synced.synced, 1);

        let submitted = service::submit_attempt(&pool, fixture.user_id, attempt_id).await?;
        assert_eq!(submitted.attempt.status, AttemptStatus::Graded);
        assert_eq!(submitted.attempt.score, Some(5), "one of two 5-mark questions answered correctly");
        assert_eq!(submitted.attempt.passed, Some(true), "5 >= passing_marks (5)");

        Ok::<(), magi_server::error::AppError>(())
    }
    .await;

    cleanup(&pool, &fixture).await;
    result.unwrap();
}
