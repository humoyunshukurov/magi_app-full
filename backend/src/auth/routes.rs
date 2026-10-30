use axum::routing::{get, post};
use axum::Router;

use super::handlers;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/signup", post(handlers::signup))
        .route("/login", post(handlers::login))
        .route("/logout", post(handlers::logout))
        .route("/verify-email/:token", post(handlers::verify_email_token))
        .route("/resend-verification", post(handlers::resend_verification))
        .route("/forgot-password", post(handlers::forgot_password))
        .route("/reset-password/:token", post(handlers::reset_password))
        .route("/me", get(handlers::get_current_user))
}
