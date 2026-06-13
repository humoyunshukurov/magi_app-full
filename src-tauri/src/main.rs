// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin entry point (ADR-0002). All wiring lives in the `magi-app` crate; this binary just
//! initializes logging and hands the generated Tauri context to `magi_app::run`.

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    if let Err(err) = magi_app::run(tauri::generate_context!()) {
        tracing::error!(%err, "fatal error running MAGI Desktop");
        std::process::exit(1);
    }
}
