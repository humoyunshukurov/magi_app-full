use axum::extract::{Path, State};

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::exams::models::{ExamDetail, ExamSummary};
use crate::exams::service;
use crate::response::ApiResponse;
use crate::state::AppState;

/// `GET /api/exams`.
pub async fn list_exams(
    State(state): State<AppState>,
    current: CurrentUser,
) -> Result<ApiResponse<Vec<ExamSummary>>, AppError> {
    current.require_student()?;
    let exams = service::list_exams(&state.pool, current.id).await?;
    Ok(ApiResponse::ok(exams))
}

/// `GET /api/exams/:id`.
pub async fn get_exam(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(exam_id): Path<i64>,
) -> Result<ApiResponse<ExamDetail>, AppError> {
    current.require_student()?;
    let exam = service::get_exam(&state.pool, current.id, exam_id).await?;
    Ok(ApiResponse::ok(exam))
}
