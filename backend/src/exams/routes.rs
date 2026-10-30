use axum::routing::get;
use axum::Router;

use super::handlers;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(handlers::list_exams)).route("/:id", get(handlers::get_exam))
}
