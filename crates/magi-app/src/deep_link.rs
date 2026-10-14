//! Deep-link launch handling (ADR-0010).
//!
//! Parses incoming `magi://launch` URLs and forwards them to the frontend via the
//! `launch://received` event: `token` is reserved for a future passwordless session claim
//! (M3, not built yet - the frontend only logs it today), `exam_id` lets the app jump straight
//! to one exam once the student is signed in, using whatever session is already on disk. The
//! payload is untrusted input either way: never persisted or logged in full, and a real,
//! already-authenticated session is still required before the exam itself does anything.

use serde::Serialize;
use tauri::{App, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

/// Event name the frontend subscribes to for launch hand-offs.
const LAUNCH_EVENT: &str = "launch://received";

/// Payload delivered to the frontend on a `magi://launch` deep link.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct LaunchPayload {
    /// The opaque launch token from the deep link (reserved for M3's session claim).
    token: Option<String>,
    /// The exam to jump straight to, once a session exists.
    exam_id: Option<i64>,
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
            if let Some(payload) = parse_launch(&url) {
                tracing::info!(exam_id = ?payload.exam_id, has_token = payload.token.is_some(), "received magi://launch deep link");
                if let Err(err) = handle.emit(LAUNCH_EVENT, payload) {
                    tracing::error!(%err, "failed to emit launch event to frontend");
                }
            } else {
                tracing::warn!(scheme = url.scheme(), "ignoring non-launch deep link");
            }
        }
    });

    Ok(())
}

/// Parse a `magi://launch` URL into its (optional) token and exam id.
///
/// Returns `None` for anything that is not a `magi` launch link at all, so callers never act
/// on an unrelated deep link; returns `Some` with both fields `None` for a bare `magi://launch`,
/// which is a harmless no-op the frontend just ignores.
fn parse_launch(url: &url::Url) -> Option<LaunchPayload> {
    if url.scheme() != "magi" {
        return None;
    }
    // `magi://launch?...` parses with host = "launch"; tolerate it as a path too.
    let is_launch = url.host_str() == Some("launch") || url.path().trim_matches('/') == "launch";
    if !is_launch {
        return None;
    }

    let mut token = None;
    let mut exam_id = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "token" if !value.is_empty() => token = Some(value.into_owned()),
            "examId" => exam_id = value.parse::<i64>().ok(),
            _ => {}
        }
    }

    Some(LaunchPayload { token, exam_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Option<LaunchPayload> {
        parse_launch(&url::Url::parse(s).unwrap())
    }

    #[test]
    fn extracts_token_and_exam_id_together() {
        assert_eq!(
            parse("magi://launch?token=stub&examId=42"),
            Some(LaunchPayload { token: Some("stub".to_string()), exam_id: Some(42) })
        );
    }

    #[test]
    fn exam_id_alone_is_enough_to_act_on() {
        assert_eq!(parse("magi://launch?examId=42"), Some(LaunchPayload { token: None, exam_id: Some(42) }));
    }

    #[test]
    fn token_alone_still_works_for_the_future_claim_flow() {
        assert_eq!(parse("magi://launch?token=stub"), Some(LaunchPayload { token: Some("stub".to_string()), exam_id: None }));
    }

    #[test]
    fn rejects_wrong_scheme_or_path() {
        assert_eq!(parse("https://launch?token=stub"), None);
        assert_eq!(parse("magi://other?token=stub"), None);
    }

    #[test]
    fn a_bare_launch_link_has_nothing_to_act_on() {
        assert_eq!(parse("magi://launch"), Some(LaunchPayload { token: None, exam_id: None }));
    }

    #[test]
    fn ignores_an_empty_token_or_an_unparsable_exam_id() {
        assert_eq!(parse("magi://launch?token=&examId=not-a-number"), Some(LaunchPayload { token: None, exam_id: None }));
    }
}
