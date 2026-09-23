//! Environment configuration for the server binary.

use std::env;

/// Server configuration, read once at startup from the process environment.
#[derive(Debug, Clone)]
pub struct Config {
    /// Direct Postgres connection string (the same Supabase project the TS backend uses).
    pub database_url: String,
    /// HMAC secret the bearer JWTs are signed with.
    pub jwt_secret: String,
    /// TCP port the HTTP server listens on.
    pub port: u16,
    /// How long an issued bearer token stays valid, absent a logout.
    pub token_ttl_days: i64,
}

/// Errors that can occur while reading [`Config`] from the environment.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A required environment variable is missing.
    #[error("missing environment variable: {0}")]
    Missing(&'static str),
    /// A variable was present but could not be parsed into the expected type.
    #[error("invalid value for {0}")]
    Invalid(&'static str),
}

impl Config {
    /// Reads configuration from the environment (`.env` is loaded by the caller via `dotenvy`).
    ///
    /// # Errors
    /// Returns [`ConfigError`] if a required variable is missing or malformed.
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url = env::var("DATABASE_URL").map_err(|_| ConfigError::Missing("DATABASE_URL"))?;
        let jwt_secret = env::var("JWT_SECRET").map_err(|_| ConfigError::Missing("JWT_SECRET"))?;
        let port = env::var("PORT")
            .unwrap_or_else(|_| "8081".to_string())
            .parse()
            .map_err(|_| ConfigError::Invalid("PORT"))?;
        let token_ttl_days = env::var("TOKEN_TTL_DAYS")
            .unwrap_or_else(|_| "7".to_string())
            .parse()
            .map_err(|_| ConfigError::Invalid("TOKEN_TTL_DAYS"))?;

        Ok(Self { database_url, jwt_secret, port, token_ttl_days })
    }
}
