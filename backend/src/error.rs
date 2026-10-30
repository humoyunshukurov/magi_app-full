//! The one error type every handler and service function returns.
//!
//! Mirrors the TS backend's `HttpError` (expected failures carry a status + message) plus a
//! catch-all for anything unexpected, which becomes a 500 the same way `handleControllerError`
//! did there.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

use crate::response::ApiResponse;

/// An error that can be turned directly into an HTTP response.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 400: the request was malformed or failed validation.
    #[error("{0}")]
    BadRequest(String),
    /// 401: missing, invalid, expired or revoked bearer token.
    #[error("{0}")]
    Unauthorized(String),
    /// 403: authenticated, but not allowed to do this.
    #[error("{0}")]
    Forbidden(String),
    /// 404: the row does not exist, or exists but the caller must not learn that (same
    /// convention as the TS backend: existence is never leaked through 403).
    #[error("{0}")]
    NotFound(String),
    /// 409: conflicts with the current state (already started, already submitted, expired).
    #[error("{0}")]
    Conflict(String),
    /// Anything else: a database error, a bug. Logged, and answered as a bare 500.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::Internal(err.into())
    }
}

/// A unique-violation (Postgres `23505`) becomes a 409 with `message`; anything else is
/// just an internal error, matching the TS backend's `error.code === '23505'` convention.
pub fn map_unique_violation(err: sqlx::Error, message: &str) -> AppError {
    if let sqlx::Error::Database(db_err) = &err {
        if db_err.code().as_deref() == Some("23505") {
            return AppError::Conflict(message.to_string());
        }
    }
    AppError::Internal(err.into())
}

impl From<bcrypt::BcryptError> for AppError {
    fn from(err: bcrypt::BcryptError) -> Self {
        AppError::Internal(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message.clone()),
            AppError::Unauthorized(message) => (StatusCode::UNAUTHORIZED, message.clone()),
            AppError::Forbidden(message) => (StatusCode::FORBIDDEN, message.clone()),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, message.clone()),
            AppError::Conflict(message) => (StatusCode::CONFLICT, message.clone()),
            AppError::Internal(err) => {
                tracing::error!(error = %err, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error".to_string())
            }
        };

        (status, ApiResponse::<()>::error(message)).into_response()
    }
}
