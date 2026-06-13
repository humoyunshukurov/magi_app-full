//! Tauri entry, command handlers, and deep-link wiring (ADR-0002, ADR-0010).
//!
//! `src-tauri/src/main.rs` calls [`run`] with the generated context. Keeping the builder
//! here lets `main.rs` stay a thin shim while this crate owns all wiring.

mod commands;
mod deep_link;

use tauri::Manager;

/// Build and run the Tauri application.
///
/// The context is generated in `src-tauri` (where `tauri.conf.json` and the build script
/// live) and passed in, so `generate_context!` resolves against the binary crate.
///
/// # Errors
/// Returns any error raised while building or running the Tauri event loop.
pub fn run(context: tauri::Context<tauri::Wry>) -> tauri::Result<()> {
    tauri::Builder::default()
        // single-instance MUST be registered first; with the `deep-link` feature it
        // forwards `magi://` launches from a second process into the running instance
        // (the Windows/Linux deep-link path).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        // NOTE: the `updater` plugin is a declared dependency but is intentionally NOT
        // registered at M0 — it requires a signing pubkey + update endpoints
        // (`plugins.updater` config) that are part of M7 (Release Infrastructure, ADR-0008).
        // Registering it without config makes startup fail. Wire it up in M7.
        .setup(|app| {
            deep_link::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![commands::ping])
        .run(context)
}
