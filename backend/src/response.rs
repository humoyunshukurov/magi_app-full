//! The one response envelope every endpoint answers with.
//!
//! The TS backend put `success` on every response except `get-user`, which just returned
//! `req.user` bare. That inconsistency isn't worth reproducing, so here every endpoint,
//! including "who am I", answers `{ success, data?, message? }`: `data` holds the payload on
//! success, `message` holds a human-readable note (present on every error, optional on success).

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl<T> ApiResponse<T> {
    /// A successful response carrying a payload.
    pub fn ok(data: T) -> Self {
        Self { success: true, data: Some(data), message: None }
    }

    /// A successful response that is just a confirmation message (no payload).
    pub fn message(message: impl Into<String>) -> Self {
        Self { success: true, data: None, message: Some(message.into()) }
    }

    /// An error response. Used directly by [`crate::error::AppError`]'s `IntoResponse` impl.
    pub fn error(message: impl Into<String>) -> Self {
        Self { success: false, data: None, message: Some(message.into()) }
    }
}

impl<T: Serialize> IntoResponse for ApiResponse<T> {
    fn into_response(self) -> Response {
        let status = if self.success { StatusCode::OK } else { StatusCode::INTERNAL_SERVER_ERROR };
        (status, Json(self)).into_response()
    }
}
