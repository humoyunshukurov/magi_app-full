//! The `tokens`/`users_tokens` tables: email-verification tokens, password-reset tokens, and
//! (new here) the bearer login token itself.
//!
//! The TS backend stores the raw JWT in `tokens.token` for a login token, since it never
//! looks the row up again (`protectRoute` only verifies the JWT signature - logout just
//! clears the cookie, the row is never consulted, which is the "logout doesn't revoke"
//! bug this port fixes). Since bearer auth here DOES look the row up on every request, the
//! bearer token is hashed before it is stored, the same way the verify/reset tokens already
//! were - a stolen database dump should not hand out live bearer tokens either.

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::error::AppError;

/// `public.type_token_type`. Only the two the auth flows use here plus `cookie_token_login`,
/// which is what a bearer token is stored as - it is still, semantically, "the token that
/// proves you logged in", the enum just predates bearer auth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type)]
#[sqlx(type_name = "type_token_type", rename_all = "snake_case")]
pub enum TokenType {
    VerifyAccountEmail,
    UpdateAccountPassword,
    CookieTokenLogin,
}

pub fn sha256_hex(raw: &str) -> String {
    let digest = Sha256::digest(raw.as_bytes());
    hex::encode(digest)
}

/// A random 40-hex-char token (20 bytes), matching `crypto.randomBytes(20).toString('hex')`.
pub fn random_hex() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 20];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Stores a token row and its `users_tokens` link in one transaction (the TS version did the
/// two inserts separately with nothing to undo the first if the second failed).
///
/// # Errors
/// Returns [`AppError::Internal`] on any database failure.
pub async fn store(
    pool: &PgPool,
    user_id: i64,
    token_hash: &str,
    token_type: TokenType,
    expires_at: DateTime<Utc>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let token_id: i64 = sqlx::query_scalar(
        "insert into public.tokens (token, token_type, expires_at) values ($1, $2, $3) returning id",
    )
    .bind(token_hash)
    .bind(token_type)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("insert into public.users_tokens (user_id, token_id) values ($1, $2)")
        .bind(user_id)
        .bind(token_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}

struct TokenRow {
    id: i64,
    expires_at: DateTime<Utc>,
    revoked: bool,
}

async fn find(pool: &PgPool, token_hash: &str, token_type: TokenType) -> Result<Option<TokenRow>, AppError> {
    let row = sqlx::query_as::<_, (i64, DateTime<Utc>, bool)>(
        "select id, expires_at, revoked from public.tokens where token = $1 and token_type = $2",
    )
    .bind(token_hash)
    .bind(token_type)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, expires_at, revoked)| TokenRow { id, expires_at, revoked }))
}

/// The user id a still-live (not revoked, not expired) token belongs to, or `None`.
pub async fn user_for_valid_token(
    pool: &PgPool,
    raw_token: &str,
    token_type: TokenType,
) -> Result<Option<i64>, AppError> {
    let hash = sha256_hex(raw_token);
    let Some(row) = find(pool, &hash, token_type).await? else { return Ok(None) };
    if row.revoked || row.expires_at <= Utc::now() {
        return Ok(None);
    }

    let user_id = sqlx::query_scalar::<_, i64>("select user_id from public.users_tokens where token_id = $1")
        .bind(row.id)
        .fetch_optional(pool)
        .await?;
    Ok(user_id)
}

/// Marks every row for this token+type revoked (there's only ever one, but this mirrors the
/// TS backend's `.eq('token', ...).eq('token_type', ...)` update).
pub async fn revoke(pool: &PgPool, raw_token: &str, token_type: TokenType) -> Result<(), AppError> {
    let hash = sha256_hex(raw_token);
    sqlx::query("update public.tokens set revoked = true where token = $1 and token_type = $2")
        .bind(hash)
        .bind(token_type)
        .execute(pool)
        .await?;
    Ok(())
}

/// Is this bearer token still valid (not revoked, not expired)? Used on every authenticated
/// request - the actual fix for the TS logout bug: a captured token stops working the moment
/// it's revoked, instead of only when its 7-day JWT expiry catches up.
pub async fn is_login_token_valid(pool: &PgPool, raw_token: &str) -> Result<bool, AppError> {
    let hash = sha256_hex(raw_token);
    let Some(row) = find(pool, &hash, TokenType::CookieTokenLogin).await? else { return Ok(false) };
    Ok(!row.revoked && row.expires_at > Utc::now())
}
