//! Tauri entry, command handlers, and deep-link wiring (ADR-0002, ADR-0010).
//!
//! `src-tauri/src/main.rs` calls [`run`] with the generated context. Keeping the builder
//! here lets `main.rs` stay a thin shim while this crate owns all wiring.

#[cfg(target_os = "linux")]
mod camera;
mod commands;
mod deep_link;
mod environment;
mod keychain;
mod link;
mod screenshot;

use tauri::{Emitter, Manager};

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        // full screen belongs to an open exam only, so it isn't remembered for the next launch
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        // M7 (ADR-0008): the pubkey + GitHub Releases endpoint live in tauri.conf.json's
        // `plugins.updater` config, which this plugin reads at startup.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            deep_link::setup(app)?;
            open_storage(app);
            app.manage(commands::CameraState::default());
            app.manage(commands::ExamState::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window while an exam is open is reported to the exam first, which writes
            // it down, takes a picture of the screen and then quits by itself.
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let open = window
                .try_state::<commands::ExamState>()
                .is_some_and(|s| s.open.load(std::sync::atomic::Ordering::SeqCst));
            if window.label() != "main" || !open {
                return;
            }
            api.prevent_close();
            let _ = window.emit("close-attempt", ());
            // if the page can't answer (it has hung), the app still closes
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                app.exit(0);
            });
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::draft_save,
            commands::draft_load,
            commands::draft_clear,
            commands::activity_log,
            commands::activity_attempts,
            commands::activity_list,
            commands::camera_start,
            commands::camera_stop,
            commands::environment_check,
            commands::exam_lock,
            commands::screenshot_take,
            commands::app_quit,
            commands::link_open,
            commands::link_close
        ])
        .run(context)
}

/// Opens the encrypted local store and registers it as managed state. A failure (no keychain
/// available, unreadable file) is logged rather than fatal: the exam still works, just
/// without local drafts.
fn open_storage(app: &tauri::App) {
    let opened = (|| -> Result<magi_storage::Storage, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let key = keychain::db_key()?;
        Ok(magi_storage::Storage::open(&dir.join("magi.db"), &key)?)
    })();
    match opened {
        Ok(storage) => {
            app.manage(storage);
        }
        Err(err) => tracing::error!(%err, "local storage unavailable, answer drafts won't be kept"),
    }
}
