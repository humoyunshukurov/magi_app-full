//! Auth handlers. Ports `features/auth/auth.controller.ts`; the TS backend has no
//! `auth.service.ts` (its logic sits in the controller) so this file is the equivalent of
//! both, kept thin per handler and calling straight into `sqlx`.

use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use crate::auth::middleware::CurrentUser;
use crate::auth::models::{
    ForgotPasswordRequest, LoginRequest, LoginResponse, ResendVerificationRequest, ResetPasswordRequest,
    SignupRequest, UserSummary,
};
use crate::auth::token_store::{self, TokenType};
use crate::auth::{jwt, password};
use crate::error::AppError;
use crate::response::ApiResponse;
use crate::state::AppState;

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

struct UserRow {
    id: i64,
    first_name: String,
    last_name: Option<String>,
    email: String,
    password: String,
    is_verified: bool,
    active_status: String,
    deleted_at: Option<DateTime<Utc>>,
}

async fn find_user_by_email(pool: &PgPool, email: &str) -> Result<Option<UserRow>, AppError> {
    let row = sqlx::query_as::<_, (i64, String, Option<String>, String, String, bool, String, Option<DateTime<Utc>>)>(
        "select id, first_name, last_name, email, password, is_verified, active_status::text, deleted_at \
         from public.users where email = $1",
    )
    .bind(email)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|(id, first_name, last_name, email, password, is_verified, active_status, deleted_at)| UserRow {
        id,
        first_name,
        last_name,
        email,
        password,
        is_verified,
        active_status,
        deleted_at,
    }))
}

async fn user_role(pool: &PgPool, user_id: i64) -> Result<Option<String>, AppError> {
    let role = sqlx::query_scalar::<_, Option<String>>("select public.get_user_role($1)")
        .bind(user_id)
        .fetch_one(pool)
        .await?;
    Ok(role)
}

/// `POST /api/auth/signup`. Only ever creates a student account - professor/examiner
/// authoring is out of scope this pass, so there is no reachable use for those roles here.
pub async fn signup(
    State(state): State<AppState>,
    Json(body): Json<SignupRequest>,
) -> Result<ApiResponse<()>, AppError> {
    let email = normalize_email(&body.email);
    let first_name = body.first_name.trim().to_string();
    let last_name = body.last_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    if first_name.is_empty() || email.is_empty() || body.password.is_empty() {
        return Err(AppError::BadRequest("All fields are required".to_string()));
    }
    if body.password.len() < 6 {
        return Err(AppError::BadRequest("Password must be at least 6 characters long".to_string()));
    }

    if find_user_by_email(&state.pool, &email).await?.is_some() {
        return Err(AppError::Conflict(
            "Email is already registered. Please check your email or log in.".to_string(),
        ));
    }

    let hashed = password::hash(&body.password)?;

    let mut tx = state.pool.begin().await?;
    let user_id: i64 = sqlx::query_scalar(
        "insert into public.users (first_name, last_name, email, password) values ($1, $2, $3, $4) returning id",
    )
    .bind(&first_name)
    .bind(&last_name)
    .bind(&email)
    .bind(&hashed)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("insert into public.students (user_id) values ($1)")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let raw_token = token_store::random_hex();
    token_store::store(
        &state.pool,
        user_id,
        &token_store::sha256_hex(&raw_token),
        TokenType::VerifyAccountEmail,
        Utc::now() + Duration::hours(1),
    )
    .await?;
    state.email.send_verification(&email, &raw_token).await;

    Ok(ApiResponse::message("User signed up successfully. Please verify your email address."))
}

/// `POST /api/auth/login`. Issues the bearer token in the response body (never a cookie).
pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<ApiResponse<LoginResponse>, AppError> {
    let email = normalize_email(&body.email);
    if email.is_empty() || body.password.is_empty() {
        return Err(AppError::BadRequest("Email and password are required".to_string()));
    }

    let user = find_user_by_email(&state.pool, &email)
        .await?
        .ok_or_else(|| AppError::BadRequest("Invalid email or password".to_string()))?;

    if !password::verify(&body.password, &user.password)? {
        return Err(AppError::BadRequest("Invalid email or password".to_string()));
    }
    if !user.is_verified {
        return Err(AppError::Forbidden("Email is not verified. Please check your inbox.".to_string()));
    }
    if user.deleted_at.is_some() {
        return Err(AppError::Forbidden(format!("Account is {}. Please contact support.", user.active_status)));
    }

    let role = user_role(&state.pool, user.id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Not authorized. Please contact support.".to_string()))?;

    let (token, claims) = jwt::issue(
        user.id,
        &user.first_name,
        user.last_name.as_deref(),
        &user.email,
        &role,
        state.config.token_ttl_days,
        &state.config.jwt_secret,
    )?;
    let expires_at = DateTime::from_timestamp(claims.exp, 0).unwrap_or_else(Utc::now);

    token_store::store(&state.pool, user.id, &token_store::sha256_hex(&token), TokenType::CookieTokenLogin, expires_at)
        .await?;

    Ok(ApiResponse::ok(LoginResponse {
        token,
        user: UserSummary { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, role },
    }))
}

/// `POST /api/auth/logout`. Unlike the TS backend (which only clears the cookie), this
/// actually revokes the token row, so a captured bearer token stops working immediately.
pub async fn logout(State(state): State<AppState>, current: CurrentUser) -> Result<ApiResponse<()>, AppError> {
    token_store::revoke(&state.pool, &current.raw_token, TokenType::CookieTokenLogin).await?;
    state.token_cache.forget(&current.raw_token);
    Ok(ApiResponse::message("Logged out successfully"))
}

/// `GET /api/auth/me`. Same envelope as every other endpoint (the TS `get-user` answered
/// `req.user` bare, with no `success` field - fixed here for consistency).
pub async fn get_current_user(current: CurrentUser) -> ApiResponse<UserSummary> {
    ApiResponse::ok(UserSummary {
        id: current.id,
        first_name: current.first_name,
        last_name: current.last_name,
        email: current.email,
        role: current.role,
    })
}

/// `POST /api/auth/verify-email/:token`. Confirms the account behind a signup/resend token.
pub async fn verify_email_token(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<ApiResponse<()>, AppError> {
    let user_id = token_store::user_for_valid_token(&state.pool, &token, TokenType::VerifyAccountEmail)
        .await?
        .ok_or_else(|| AppError::BadRequest("Invalid or expired verification token".to_string()))?;

    let email: String = sqlx::query_scalar(
        "update public.users set is_verified = true, active_status = 'active' where id = $1 returning email",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;

    token_store::revoke(&state.pool, &token, TokenType::VerifyAccountEmail).await?;
    state.email.send_welcome(&email).await;

    Ok(ApiResponse::message("Account verified successfully"))
}

/// `POST /api/auth/resend-verification`. Same token flow as signup, for a user who never
/// received (or lost) the first email.
pub async fn resend_verification(
    State(state): State<AppState>,
    Json(body): Json<ResendVerificationRequest>,
) -> Result<ApiResponse<()>, AppError> {
    let email = normalize_email(&body.email);
    let user = find_user_by_email(&state.pool, &email)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if user.is_verified {
        return Err(AppError::BadRequest("Email is already verified".to_string()));
    }
    if user.deleted_at.is_some() {
        return Err(AppError::BadRequest(
            "Account has been permanently deleted. Please contact support if you believe this is an error.".to_string(),
        ));
    }

    let raw_token = token_store::random_hex();
    token_store::store(
        &state.pool,
        user.id,
        &token_store::sha256_hex(&raw_token),
        TokenType::VerifyAccountEmail,
        Utc::now() + Duration::hours(1),
    )
    .await?;
    state.email.send_verification(&email, &raw_token).await;

    Ok(ApiResponse::message("Verification email sent successfully"))
}

/// `POST /api/auth/forgot-password`.
pub async fn forgot_password(
    State(state): State<AppState>,
    Json(body): Json<ForgotPasswordRequest>,
) -> Result<ApiResponse<()>, AppError> {
    let email = normalize_email(&body.email);
    let user = find_user_by_email(&state.pool, &email)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found".to_string()))?;

    if !user.is_verified {
        return Err(AppError::Forbidden("Email is not verified".to_string()));
    }
    if user.deleted_at.is_some() {
        return Err(AppError::Forbidden("Account is deactivated. Please contact support.".to_string()));
    }

    let raw_token = token_store::random_hex();
    token_store::store(
        &state.pool,
        user.id,
        &token_store::sha256_hex(&raw_token),
        TokenType::UpdateAccountPassword,
        Utc::now() + Duration::hours(1),
    )
    .await?;
    state.email.send_password_reset(&email, &raw_token).await;

    Ok(ApiResponse::message("Password reset email sent successfully"))
}

/// `POST /api/auth/reset-password/:token`.
pub async fn reset_password(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<ApiResponse<()>, AppError> {
    if body.new_password.len() < 6 {
        return Err(AppError::BadRequest("Password must be at least 6 characters long".to_string()));
    }

    let user_id = token_store::user_for_valid_token(&state.pool, &token, TokenType::UpdateAccountPassword)
        .await?
        .ok_or_else(|| AppError::BadRequest("Invalid or expired token".to_string()))?;

    let hashed = password::hash(&body.new_password)?;
    let email: String = sqlx::query_scalar("update public.users set password = $1 where id = $2 returning email")
        .bind(&hashed)
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;

    token_store::revoke(&state.pool, &token, TokenType::UpdateAccountPassword).await?;
    state.email.send_reset_success(&email).await;

    Ok(ApiResponse::message("Password has been reset successfully"))
}
