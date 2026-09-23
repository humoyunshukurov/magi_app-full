//! Bearer JWTs (ADR-0004: REST + bearer auth, not cookies).
//!
//! The claims mirror the TS backend's `generateToken` payload (id/first_name/last_name/
//! email/role) so a captured token carries the same information either way; only the
//! transport changed from an httpOnly cookie to an `Authorization: Bearer` header.

use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// `users.id`.
    pub sub: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub email: String,
    pub role: String,
    pub iat: i64,
    pub exp: i64,
}

/// Signs a fresh token for `user_id`, valid for `ttl_days`.
///
/// # Errors
/// Returns [`AppError::Internal`] if signing fails (it doesn't, barring an inconsistent key).
pub fn issue(
    user_id: i64,
    first_name: &str,
    last_name: Option<&str>,
    email: &str,
    role: &str,
    ttl_days: i64,
    secret: &str,
) -> Result<(String, Claims), AppError> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        first_name: first_name.to_string(),
        last_name: last_name.map(str::to_string),
        email: email.to_string(),
        role: role.to_string(),
        iat: now.timestamp(),
        exp: (now + chrono::Duration::days(ttl_days)).timestamp(),
    };

    let token = encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .map_err(|err| AppError::Internal(err.into()))?;

    Ok((token, claims))
}

/// Verifies signature and expiry, returning the claims.
///
/// # Errors
/// Returns [`AppError::Unauthorized`] for any signature, expiry or shape failure - the caller
/// must not be able to tell which.
pub fn verify(token: &str, secret: &str) -> Result<Claims, AppError> {
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &Validation::default())
        .map(|data| data.claims)
        .map_err(|_| AppError::Unauthorized("Not authorized, invalid or expired token".to_string()))
}
