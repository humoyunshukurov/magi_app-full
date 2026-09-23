use axum::extract::{Path, State};
use axum::Json;

use crate::auth::CurrentUser;
use crate::error::AppError;
use crate::monitoring::models::{AddMediaRequest, MediaRecord};
use crate::monitoring::service::{self, MediaKind};
use crate::response::ApiResponse;
use crate::state::AppState;

/// `POST /api/monitoring/attempts/:attempt_id/:kind`.
pub async fn add_media(
    State(state): State<AppState>,
    current: CurrentUser,
    Path((attempt_id, kind)): Path<(i64, String)>,
    Json(body): Json<AddMediaRequest>,
) -> Result<ApiResponse<MediaRecord>, AppError> {
    current.require_student()?;
    let kind = MediaKind::parse(&kind)?;
    let media = service::add_media(&state.pool, kind, attempt_id, current.id, &body.url).await?;
    Ok(ApiResponse::ok(media))
}
