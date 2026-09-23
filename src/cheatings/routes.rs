use axum::routing::post;
use axum::Router;

use super::handlers;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/attempts/:attempt_id", post(handlers::create_incident))
}
