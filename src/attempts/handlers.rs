use axum::extract::{Path, State};
use axum::Json;

use crate::attempts::models::{AttemptDetail, AttemptSummary, StartAttemptRequest, SubmitResponse, SyncAnswersRequest, SyncAnswersResponse};
use crate::attempts::service;
use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::response::ApiResponse;
use crate::state::AppState;

/// `POST /api/attempts`.
pub async fn start_attempt(
    State(state): State<AppState>,
    current: CurrentUser,
    Json(body): Json<StartAttemptRequest>,
) -> Result<ApiResponse<AttemptDetail>, AppError> {
    current.require_student()?;
    let attempt = service::start_attempt(&state.pool, current.id, body.exam_id).await?;
    Ok(ApiResponse::ok(attempt))
}

/// `GET /api/attempts/my`.
pub async fn list_my_attempts(
    State(state): State<AppState>,
    current: CurrentUser,
) -> Result<ApiResponse<Vec<AttemptSummary>>, AppError> {
    current.require_student()?;
    let attempts = service::list_my_attempts(&state.pool, current.id).await?;
    Ok(ApiResponse::ok(attempts))
}

/// `GET /api/attempts/:id`.
pub async fn get_attempt(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(attempt_id): Path<i64>,
) -> Result<ApiResponse<AttemptDetail>, AppError> {
    current.require_student()?;
    let attempt = service::get_attempt(&state.pool, current.id, attempt_id).await?;
    Ok(ApiResponse::ok(attempt))
}

/// `PUT /api/attempts/:id/answers`.
pub async fn sync_answers(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(attempt_id): Path<i64>,
    Json(body): Json<SyncAnswersRequest>,
) -> Result<ApiResponse<SyncAnswersResponse>, AppError> {
    current.require_student()?;
    let result = service::sync_answers(&state.pool, current.id, attempt_id, body.answers).await?;
    Ok(ApiResponse::ok(result))
}

/// `POST /api/attempts/:id/submit`.
pub async fn submit_attempt(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(attempt_id): Path<i64>,
) -> Result<ApiResponse<SubmitResponse>, AppError> {
    current.require_student()?;
    let result = service::submit_attempt(&state.pool, current.id, attempt_id).await?;
    Ok(ApiResponse::ok(result))
}
