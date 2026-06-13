//! Deep-link launch handling (ADR-0010).
//!
//! Parses incoming `magi://launch?token=…` URLs and forwards the token to the frontend
//! via the `launch://received` event. M0 only *observes* the token — claiming the session
//! against the backend is M3. The launch token is treated as untrusted input: it is never
//! persisted or logged in full, and the real authority is the backend `claim` round-trip.

use serde::Serialize;
use tauri::{App, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

/// Event name the frontend subscribes to for launch hand-offs.
const LAUNCH_EVENT: &str = "launch://received";

/// Payload delivered to the frontend on a `magi://launch` deep link.
#[derive(Debug, Clone, Serialize)]
struct LaunchPayload {
    /// The opaque launch token from the deep link (server-signed, 5-min TTL, single-use).
    token: String,
}

/// Wire up deep-link handling during Tauri setup.
///
/// # Errors
/// Returns an error if runtime scheme registration fails on platforms that require it.
pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // On Windows and Linux the scheme must be registered with the OS; in dev this also
    // makes `cargo tauri dev` handle `magi://` without a full install. macOS registers
    // the scheme from Info.plist at bundle time, so this is a no-op there.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        app.deep_link().register_all()?;
    }

    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            if let Some(token) = parse_launch_token(&url) {
                tracing::info!(token_len = token.len(), "received magi://launch deep link");
                if let Err(err) = handle.emit(LAUNCH_EVENT, LaunchPayload { token }) {
                    tracing::error!(%err, "failed to emit launch event to frontend");
                }
            } else {
                tracing::warn!(scheme = url.scheme(), "ignoring non-launch deep link");
            }
        }
    });

    Ok(())
}

/// Extract the `token` query parameter from a `magi://launch?token=…` URL.
///
/// Returns `None` for any URL that is not a `magi` launch link or lacks a token, so callers
/// never act on a malformed deep link.
fn parse_launch_token(url: &url::Url) -> Option<String> {
    if url.scheme() != "magi" {
        return None;
    }
    // `magi://launch?token=…` parses with host = "launch"; tolerate it as a path too.
    let is_launch = url.host_str() == Some("launch") || url.path().trim_matches('/') == "launch";
    if !is_launch {
        return None;
    }
    url.query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Option<String> {
        parse_launch_token(&url::Url::parse(s).unwrap())
    }

    #[test]
    fn extracts_token_from_launch_url() {
        assert_eq!(parse("magi://launch?token=stub"), Some("stub".to_string()));
    }

    #[test]
    fn rejects_wrong_scheme_and_missing_token() {
        assert_eq!(parse("https://launch?token=stub"), None);
        assert_eq!(parse("magi://launch"), None);
        assert_eq!(parse("magi://other?token=stub"), None);
        assert_eq!(parse("magi://launch?token="), None);
    }
}
