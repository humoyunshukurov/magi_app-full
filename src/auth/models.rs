//! Request/response DTOs for the auth endpoints, exported to `frontend/src/generated/` via
//! `ts-rs` (see `crates/magi-types/src/lib.rs` for the pattern this follows).

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct SignupRequest {
    pub first_name: String,
    pub last_name: Option<String>,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ResendVerificationRequest {
    pub email: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ForgotPasswordRequest {
    pub email: String,
}

#[derive(Debug, Deserialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct ResetPasswordRequest {
    pub new_password: String,
}

/// The caller's own account, minus the password hash. Answered by `login` (alongside the
/// token) and by `get-current-user` on its own.
#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct UserSummary {
    pub id: i64,
    pub first_name: String,
    pub last_name: Option<String>,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Serialize, TS)]
#[ts(export, export_to = "../../../frontend/src/generated/")]
pub struct LoginResponse {
    /// Bearer token: send back as `Authorization: Bearer <token>`.
    pub token: String,
    pub user: UserSummary,
}
