//! Shared application state, cloned into every handler (axum's `State` extractor).

use std::sync::Arc;

use sqlx::PgPool;

use crate::auth::token_cache::TokenCache;
use crate::config::Config;
use crate::email::EmailSender;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub config: Arc<Config>,
    pub email: Arc<dyn EmailSender>,
    pub token_cache: TokenCache,
}
