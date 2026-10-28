//! Tauri IPC command handlers. The IPC surface is intentionally narrow and typed
//! (ADR-0002): every command's types come from `magi-types`.

use magi_storage::Storage;
use magi_types::{ActivityAttempt, ActivityEvent, AnswerDraft, PingResponse};
use tauri::Manager;

/// Demo command proving the React → `magi-app` → `magi-core` path.
#[tauri::command]
pub fn ping() -> PingResponse {
    magi_core::ping()
}

// Answer drafts: the exam screen writes here on every keystroke and reads them back after a
// crash or restart. Async so the SQLite writes stay off the main thread. If the encrypted
// store couldn't be opened at startup (see `lib.rs`) these return an error and the frontend
// carries on without local drafts.

fn storage(app: &tauri::AppHandle) -> Result<tauri::State<'_, Storage>, String> {
    app.try_state::<Storage>()
        .ok_or_else(|| "local storage is unavailable".to_string())
}

#[tauri::command(async)]
pub fn draft_save(app: tauri::AppHandle, draft: AnswerDraft) -> Result<(), String> {
    storage(&app)?.save_draft(&draft).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn draft_load(app: tauri::AppHandle, attempt_id: i64) -> Result<Vec<AnswerDraft>, String> {
    storage(&app)?
        .load_drafts(attempt_id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn draft_clear(app: tauri::AppHandle, attempt_id: i64) -> Result<(), String> {
    storage(&app)?
        .clear_drafts(attempt_id)
        .map_err(|e| e.to_string())
}

// The Activity page's record of what the student did; same rules as the drafts above.

#[tauri::command(async)]
pub fn activity_log(app: tauri::AppHandle, event: ActivityEvent) -> Result<(), String> {
    storage(&app)?.log_event(&event).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn activity_attempts(
    app: tauri::AppHandle,
    user_id: i64,
) -> Result<Vec<ActivityAttempt>, String> {
    storage(&app)?
        .list_activity_attempts(user_id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn activity_list(
    app: tauri::AppHandle,
    user_id: i64,
    attempt_id: i64,
) -> Result<Vec<ActivityEvent>, String> {
    storage(&app)?
        .list_activity(user_id, attempt_id)
        .map_err(|e| e.to_string())
}

// The camera while an exam is open. On Linux the frames are read natively and pushed to the page
// as `camera-frame` events (base64 JPEG); elsewhere the webview opens the camera itself.

#[derive(Default)]
pub struct CameraState {
    #[cfg(target_os = "linux")]
    running: std::sync::Mutex<Option<crate::camera::Running>>,
}

/// Starts the camera. `Some(name)` means it is running and streaming frames; `None` means this
/// platform's webview can use the camera by itself.
#[tauri::command(async)]
pub fn camera_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CameraState>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        use base64::Engine;
        use tauri::Emitter;

        let mut running = state.running.lock().map_err(|e| e.to_string())?;
        if let Some(camera) = running.as_ref() {
            return Ok(Some(camera.name.clone()));
        }
        let frames = app.clone();
        let lost = app;
        let camera = crate::camera::start(
            move |jpeg| {
                let _ = frames.emit(
                    "camera-frame",
                    base64::engine::general_purpose::STANDARD.encode(jpeg),
                );
            },
            move |err| {
                let _ = lost.emit("camera-lost", err);
            },
        )?;
        let name = camera.name.clone();
        *running = Some(camera);
        Ok(Some(name))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, state);
        Ok(None)
    }
}

#[tauri::command(async)]
pub fn camera_stop(state: tauri::State<'_, CameraState>) {
    #[cfg(target_os = "linux")]
    if let Some(camera) = state.running.lock().ok().and_then(|mut r| r.take()) {
        camera.stop();
    }
    #[cfg(not(target_os = "linux"))]
    let _ = state;
}

// Checks on the computer around the exam.

/// Screens and running apps, for the check before an exam and for watching it while it runs.
#[tauri::command(async)]
pub fn environment_check(app: tauri::AppHandle) -> magi_types::EnvironmentReport {
    crate::environment::report(&app)
}

/// Whether an exam is open, which decides what closing the window does.
#[derive(Default)]
pub struct ExamState {
    pub open: std::sync::atomic::AtomicBool,
}

/// Full screen, no window chrome, and pinned on top for as long as an exam is open, so it isn't
/// easy to wander off from it. While it is open, closing the window is first reported to the
/// exam (see `lib.rs`).
#[tauri::command]
pub fn exam_lock(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExamState>,
    on: bool,
) -> Result<(), String> {
    state.open.store(on, std::sync::atomic::Ordering::SeqCst);
    let window = app.get_webview_window("main").ok_or("no exam window")?;
    window.set_fullscreen(on).map_err(|e| e.to_string())?;
    window.set_decorations(!on).map_err(|e| e.to_string())?;
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

/// A picture of the screen, as a base64 JPEG. It can wait for the student to allow it, hence async.
#[tauri::command(async)]
pub fn screenshot_take() -> Result<String, String> {
    crate::screenshot::take()
}

/// Closes the app for real, after the exam has written down that the student tried to.
#[tauri::command]
pub fn app_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Opens one of the exam's permitted links in its own window; `permitted` is the exam's whole list.
#[tauri::command]
pub fn link_open(app: tauri::AppHandle, url: String, permitted: Vec<String>) -> Result<(), String> {
    crate::link::open(&app, &url, &permitted)
}

#[tauri::command]
pub fn link_close(app: tauri::AppHandle) {
    crate::link::close(&app);
}
