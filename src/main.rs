//! Thin binary entry: load config, connect, serve. All the wiring lives in `lib.rs`.

use std::sync::Arc;

use magi_server::config::Config;
use magi_server::email::NoopEmailSender;
use magi_server::state::AppState;
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt::init();

    let config = Config::from_env().map_err(|err| anyhow::anyhow!(err))?;
    let pool = PgPoolOptions::new().max_connections(5).connect(&config.database_url).await?;

    let port = config.port;
    let state = AppState { pool, config: Arc::new(config), email: Arc::new(NoopEmailSender) };
    let app = magi_server::build_router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(%port, "magi-server listening");
    axum::serve(listener, app).await?;

    Ok(())
}
