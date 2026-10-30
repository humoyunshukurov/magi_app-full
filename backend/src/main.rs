//! Thin binary entry: load config, connect, serve. All the wiring lives in `lib.rs`.

use std::sync::Arc;

use magi_server::config::Config;
use magi_server::email::NoopEmailSender;
use magi_server::state::AppState;
use sqlx::postgres::PgPoolOptions;
use sqlx::Connection;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _ = dotenvy::dotenv();
    tracing_subscriber::fmt::init();

    let config = Config::from_env().map_err(|err| anyhow::anyhow!(err))?;
    // The database is remote, and opening a connection to it (TLS + auth) takes 1-2 s. Keep a few
    // open for good so a request after a quiet spell doesn't pay for that.
    let pool = PgPoolOptions::new()
        // attempt detail runs six queries at once, so keep that many open
        .max_connections(8)
        .min_connections(6)
        .idle_timeout(None)
        // Never recycle: a replacement connection is a cold one, and cold ones are slow to first use.
        .max_lifetime(None)
        // A health check before every query costs a round trip each. Only check connections that
        // sat idle for a while, since those are the ones the pooler may have dropped.
        .test_before_acquire(false)
        .before_acquire(|conn, meta| {
            Box::pin(async move {
                if meta.idle_for < std::time::Duration::from_secs(10) {
                    return Ok(true);
                }
                Ok(conn.ping().await.is_ok())
            })
        })
        .connect(&config.database_url)
        .await?;

    // Open all of the pool's connections now (each holds its connection for a moment, so they
    // really are distinct), rather than making the first requests wait for them.
    let mut warmup = tokio::task::JoinSet::new();
    for _ in 0..6 {
        let pool = pool.clone();
        warmup.spawn(async move { sqlx::query("select pg_sleep(0.3)").execute(&pool).await });
    }
    while warmup.join_next().await.is_some() {}

    let port = config.port;
    let state = AppState { pool, config: Arc::new(config), email: Arc::new(NoopEmailSender), token_cache: Default::default() };
    let app = magi_server::build_router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(%port, "magi-server listening");
    axum::serve(listener, app).await?;

    Ok(())
}
