//! The student-facing exam-proctoring API (ADR-0002: workspace split by concern; ADR-0004:
//! REST + bearer auth). A separately deployed HTTP service - see the crate README - that
//! ports the student flows of the existing Express/Supabase backend into Rust so the whole
//! stack (this desktop client + its backend) is one language.
//!
//! Scope this pass: auth, read-only exams, attempts, monitoring uploads and cheating
//! reports, all as a student sees them. No professor/examiner-authoring endpoints, no admin.

pub mod access;
pub mod attempts;
pub mod auth;
pub mod cheatings;
pub mod config;
pub mod deadline;
pub mod email;
pub mod error;
pub mod exams;
pub mod monitoring;
pub mod response;
pub mod state;

use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// Builds the full application router: every domain mounted under `/api/...`, wrapped in
/// request tracing and a permissive CORS layer (this repo's own Vite dev server runs on a
/// different origin than the API).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", axum::routing::get(|| async { "ok" }))
        .nest("/api/auth", auth::routes::router())
        .nest("/api/exams", exams::routes::router())
        .nest("/api/attempts", attempts::routes::router())
        .nest("/api/monitoring", monitoring::routes::router())
        .nest("/api/cheatings", cheatings::routes::router())
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
