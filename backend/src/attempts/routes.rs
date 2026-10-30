use axum::routing::{get, post, put};
use axum::Router;

use super::handlers;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", post(handlers::start_attempt))
        .route("/my", get(handlers::list_my_attempts))
        .route("/:id", get(handlers::get_attempt))
        .route("/:id/answers", put(handlers::sync_answers))
        .route("/:id/file", post(handlers::upload_answer_file))
        .route("/:id/submit", post(handlers::submit_attempt))
}
