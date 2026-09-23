use axum::extract::{Path, State};
use axum::Json;

use crate::auth::CurrentUser;
use crate::cheatings::models::{CheatingRecord, CreateCheatingRequest};
use crate::cheatings::service;
use crate::error::AppError;
use crate::response::ApiResponse;
use crate::state::AppState;

/// `POST /api/cheatings/attempts/:attempt_id`.
pub async fn create_incident(
    State(state): State<AppState>,
    current: CurrentUser,
    Path(attempt_id): Path<i64>,
    Json(body): Json<CreateCheatingRequest>,
) -> Result<ApiResponse<CheatingRecord>, AppError> {
    current.require_student()?;
    let incident = service::create_incident(&state.pool, attempt_id, current.id, body.name, &body.explanation).await?;
    Ok(ApiResponse::ok(incident))
}
