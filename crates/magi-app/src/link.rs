//! Permitted links: a page the exam allows, opened in its own window so the student can look at
//! it without leaving the exam. The window can't go anywhere but the permitted sites, and the
//! exam is told when it gains or loses focus, is closed, or tries to go elsewhere.

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

fn host_of(url: &Url) -> Option<String> {
    match url.scheme() {
        "http" | "https" => url.host_str().map(str::to_lowercase),
        _ => None,
    }
}

/// `host` is one of `allowed`, or a subdomain of one.
fn is_allowed(host: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|a| host == a || host.ends_with(&format!(".{a}")))
}

pub fn open(app: &tauri::AppHandle, url: &str, permitted: &[String]) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    let allowed: Vec<String> = permitted
        .iter()
        .filter_map(|u| Url::parse(u).ok())
        .filter_map(|u| host_of(&u))
        .collect();
    match host_of(&target) {
        Some(host) if is_allowed(&host, &allowed) => {}
        _ => return Err("that link isn't permitted for this exam".to_string()),
    }

    if let Some(existing) = app.get_webview_window("link") {
        existing.navigate(target).map_err(|e| e.to_string())?;
        let _ = existing.set_focus();
        return Ok(());
    }

    let refused = app.clone();
    let window = WebviewWindowBuilder::new(app, "link", WebviewUrl::External(target))
        .title("Permitted link")
        .inner_size(1000.0, 720.0)
        .on_navigation(move |to| {
            let fine = host_of(to).is_some_and(|host| is_allowed(&host, &allowed));
            if !fine {
                let _ = refused.emit("link-blocked", to.to_string());
            }
            fine
        })
        .build()
        .map_err(|e| e.to_string())?;

    let events = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(focused) => {
            let _ = events.emit("link-focus", *focused);
        }
        WindowEvent::Destroyed => {
            let _ = events.emit("link-closed", ());
        }
        _ => {}
    });
    Ok(())
}

pub fn close(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("link") {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_permitted_site_and_its_subdomains_only() {
        let allowed = vec!["example.com".to_string()];
        assert!(is_allowed("example.com", &allowed));
        assert!(is_allowed("docs.example.com", &allowed));
        assert!(!is_allowed("notexample.com", &allowed));
        assert!(!is_allowed("example.com.evil.org", &allowed));
        assert!(!is_allowed("example.com", &[]));
    }

    #[test]
    fn only_web_addresses_have_a_host() {
        assert_eq!(
            host_of(&Url::parse("https://Example.com/x").unwrap()),
            Some("example.com".into())
        );
        assert_eq!(host_of(&Url::parse("file:///etc/passwd").unwrap()), None);
        assert_eq!(host_of(&Url::parse("javascript:alert(1)").unwrap()), None);
    }
}
