//! The bearer-auth extractor. Any handler that takes `CurrentUser` as an argument requires a
//! valid `Authorization: Bearer <token>` header - axum's equivalent of the TS `protectRoute`.

use async_trait::async_trait;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;

use crate::auth::{jwt, token_store};
use crate::error::AppError;
use crate::state::AppState;

/// The caller of an authenticated request, decoded from its bearer token.
pub struct CurrentUser {
    pub id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub email: String,
    pub role: String,
    /// The raw bearer token, needed again only by `logout` (to revoke it).
    pub raw_token: String,
}

impl CurrentUser {
    /// Every exams/attempts/monitoring/cheatings endpoint in this pass is student-only; this
    /// is the one role gate the TS backend's `requireRole('student')` middleware did per route.
    ///
    /// # Errors
    /// Returns [`AppError::Forbidden`] if the caller isn't a student.
    pub fn require_student(&self) -> Result<(), AppError> {
        if self.role == "student" {
            Ok(())
        } else {
            Err(AppError::Forbidden("Not authorized for this role".to_string()))
        }
    }
}

#[async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .ok_or_else(|| AppError::Unauthorized("Not authorized, token missing".to_string()))?;
        let value = header
            .to_str()
            .map_err(|_| AppError::Unauthorized("Not authorized, invalid token".to_string()))?;
        let raw_token = value
            .strip_prefix("Bearer ")
            .ok_or_else(|| AppError::Unauthorized("Not authorized, invalid token".to_string()))?
            .to_string();

        let claims = jwt::verify(&raw_token, &state.config.jwt_secret)?;

        if !token_store::is_login_token_valid(&state.pool, &raw_token).await? {
            return Err(AppError::Unauthorized("Not authorized, invalid or expired token".to_string()));
        }

        Ok(CurrentUser {
            id: claims.sub,
            first_name: claims.first_name,
            last_name: claims.last_name,
            email: claims.email,
            role: claims.role,
            raw_token,
        })
    }
}
