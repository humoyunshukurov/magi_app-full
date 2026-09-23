use axum::routing::post;
use axum::Router;

use super::handlers;
use crate::state::AppState;

/// `kind` is one of `panoramic-views`, `video-recordings`, `face-snapshots`, `snapshots`.
pub fn router() -> Router<AppState> {
    Router::new().route("/attempts/:attempt_id/:kind", post(handlers::add_media))
}
