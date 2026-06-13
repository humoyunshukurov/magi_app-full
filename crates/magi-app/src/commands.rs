//! Tauri IPC command handlers. The IPC surface is intentionally narrow and typed
//! (ADR-0002): every command's types come from `magi-types`.

use magi_types::PingResponse;

/// Demo command proving the React → `magi-app` → `magi-core` path.
#[tauri::command]
pub fn ping() -> PingResponse {
    magi_core::ping()
}
