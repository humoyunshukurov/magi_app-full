//! What is running on the student's computer: how many screens are connected, and whether an
//! app that could help cheat (remote control, screen sharing or recording) or a browser is open.
//! Read before an exam starts and again every few seconds while it runs.

use magi_types::EnvironmentReport;
use sysinfo::{ProcessesToUpdate, System};

/// Remote control and screen sharing/recording tools, matched on the start of the process name.
/// Messengers are left out on purpose: plenty of students have one open all day.
const FORBIDDEN_PREFIXES: &[&str] = &[
    "teamviewer",
    "anydesk",
    "rustdesk",
    "ultraviewer",
    "parsec",
    "remoting_host",
    "x11vnc",
    "vncviewer",
    "vncserver",
    "tigervnc",
    "zoom",
    "simplescreen",
    "vokoscreen",
    "kazam",
];
/// Names that are too short to match on their start.
const FORBIDDEN_EXACT: &[&str] = &["obs", "obs64", "obs-studio", "peek", "camtasia", "bandicam"];

const BROWSERS: &[&str] = &[
    "chrome",
    "chromium",
    "firefox",
    "msedge",
    "microsoft-edge",
    "brave",
    "opera",
    "vivaldi",
    "safari",
];

fn plain(name: &str) -> String {
    let lower = name.to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// Splits the names of running processes into the forbidden apps and the browsers among them.
fn classify<'a>(names: impl Iterator<Item = &'a str>) -> (Vec<String>, Vec<String>) {
    let mut forbidden = Vec::new();
    let mut browsers = Vec::new();
    for name in names {
        let name = plain(name);
        if let Some(found) = FORBIDDEN_PREFIXES.iter().find(|p| name.starts_with(**p)) {
            forbidden.push((*found).to_string());
        } else if let Some(found) = FORBIDDEN_EXACT.iter().find(|e| name == **e) {
            forbidden.push((*found).to_string());
        } else if let Some(found) = BROWSERS.iter().find(|b| name.starts_with(**b)) {
            browsers.push((*found).to_string());
        }
    }
    for list in [&mut forbidden, &mut browsers] {
        list.sort();
        list.dedup();
    }
    (forbidden, browsers)
}

/// The developer switch: only the exact value `1` turns it on.
fn allows_extra_screens(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| v == "1")
}

/// Same idea as `allows_extra_screens`, for `MAGI_ALLOW_OTHER_WINDOWS` - a developer's own
/// editor/terminal shouldn't block Start on their own machine. Never set for students or
/// packaged builds.
fn allows_other_windows(value: Option<&std::ffi::OsStr>) -> bool {
    value.is_some_and(|v| v == "1")
}

/// Names of other apps' visible windows, given each window's owning pid, name, and whether it's
/// minimized - pulled out so the filtering can be tested without a real window list. Only
/// `other_windows()` below calls it for real, on the platforms that have one.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
fn classify_windows(our_pid: u32, windows: impl Iterator<Item = (u32, String, bool)>) -> Vec<String> {
    let mut names: Vec<String> = windows
        .filter(|(pid, name, minimized)| *pid != our_pid && !*minimized && !name.trim().is_empty())
        .map(|(_, name, _)| name)
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Every other app's windows need to be closed before an exam starts, so there's nothing easy to
/// switch to - checked where the OS actually allows one app to see another's windows.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn other_windows() -> Vec<String> {
    let Ok(windows) = xcap::Window::all() else {
        return Vec::new();
    };
    let our_pid = std::process::id();
    let info = windows.iter().map(|w| {
        let name = w
            .app_name()
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| w.title().ok())
            .unwrap_or_default();
        (w.pid().unwrap_or(our_pid), name, w.is_minimized().unwrap_or(false))
    });
    classify_windows(our_pid, info)
}

/// Same idea on Linux, talking to X11/XWayland directly (`_NET_CLIENT_LIST` on the root window,
/// `_NET_WM_PID`/`WM_CLASS`/`_NET_WM_STATE` per window - the same properties `xcap` itself reads,
/// without pulling in its unconditional Linux `pipewire` dependency for a Wayland video-recording
/// feature this never uses).
///
/// **Real, confirmed gap on a pure-Wayland desktop**: a native Wayland client (tested here with
/// Firefox and Telegram, both running as Wayland-native apps) never registers with X11 at all, so
/// it is invisible to this and this check won't see it; an XWayland-backed app (older Electron
/// builds, some GTK3 apps, this app's own WebKitGTK window) still shows up. Windows and macOS have
/// no such split.
#[cfg(target_os = "linux")]
fn other_windows() -> Vec<String> {
    use xcb::x::{Atom, GetProperty, InternAtom, Window, ATOM_ATOM, ATOM_CARDINAL, ATOM_NONE, ATOM_STRING, ATOM_WM_CLASS};

    fn atom(conn: &xcb::Connection, name: &str) -> Option<Atom> {
        let cookie = conn.send_request(&InternAtom { only_if_exists: true, name: name.as_bytes() });
        match conn.wait_for_reply(cookie) {
            Ok(reply) if reply.atom() != ATOM_NONE => Some(reply.atom()),
            _ => None,
        }
    }

    let Ok((conn, screen_idx)) = xcb::Connection::connect(None) else {
        return Vec::new();
    };
    let Some(root) = conn.get_setup().roots().nth(screen_idx as usize).map(|s| s.root()) else {
        return Vec::new();
    };
    let Some(client_list) = atom(&conn, "_NET_CLIENT_LIST") else {
        return Vec::new();
    };

    let windows: Vec<Window> = {
        let cookie = conn.send_request(&GetProperty {
            delete: false,
            window: root,
            property: client_list,
            r#type: ATOM_NONE,
            long_offset: 0,
            long_length: 1024,
        });
        conn.wait_for_reply(cookie).map(|r| r.value::<Window>().to_vec()).unwrap_or_default()
    };

    let pid_atom = atom(&conn, "_NET_WM_PID");
    let state_atom = atom(&conn, "_NET_WM_STATE");
    let hidden_atom = atom(&conn, "_NET_WM_STATE_HIDDEN");
    let our_pid = std::process::id();

    let info = windows.into_iter().map(|window| {
        let pid = pid_atom
            .and_then(|property| {
                let cookie = conn.send_request(&GetProperty { delete: false, window, property, r#type: ATOM_CARDINAL, long_offset: 0, long_length: 4 });
                conn.wait_for_reply(cookie).ok().and_then(|r| r.value::<u32>().first().copied())
            })
            .unwrap_or(our_pid);

        let name = {
            let cookie = conn.send_request(&GetProperty { delete: false, window, property: ATOM_WM_CLASS, r#type: ATOM_STRING, long_offset: 0, long_length: 1024 });
            let class = conn.wait_for_reply(cookie).map(|r| String::from_utf8_lossy(r.value()).into_owned()).unwrap_or_default();
            // WM_CLASS holds two NUL-separated strings (instance, class) - the class name reads
            // like an app name ("Firefox", not "Navigator").
            class.split('\u{0}').nth(1).unwrap_or("").to_string()
        };

        let minimized = match (state_atom, hidden_atom) {
            (Some(property), Some(hidden)) => {
                let cookie = conn.send_request(&GetProperty { delete: false, window, property, r#type: ATOM_ATOM, long_offset: 0, long_length: 12 });
                conn.wait_for_reply(cookie).map(|r| r.value::<Atom>().contains(&hidden)).unwrap_or(false)
            }
            _ => false,
        };

        (pid, name, minimized)
    });

    classify_windows(our_pid, info)
}

pub fn report(app: &tauri::AppHandle) -> EnvironmentReport {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let names: Vec<String> = system
        .processes()
        .values()
        .map(|p| p.name().to_string_lossy().into_owned())
        .collect();
    let (forbidden_apps, browsers) = classify(names.iter().map(String::as_str));

    // if the screens can't be counted, don't hold the student back for it
    let monitor_count = app
        .available_monitors()
        .map(|monitors| monitors.len() as u32)
        .unwrap_or(1);

    EnvironmentReport {
        monitor_count,
        extra_screens_allowed: allows_extra_screens(
            std::env::var_os("MAGI_ALLOW_EXTRA_SCREENS").as_deref(),
        ),
        forbidden_apps,
        browsers,
        other_windows: other_windows(),
        other_windows_allowed: allows_other_windows(
            std::env::var_os("MAGI_ALLOW_OTHER_WINDOWS").as_deref(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(names: &[&str]) -> (Vec<String>, Vec<String>) {
        classify(names.iter().copied())
    }

    #[test]
    fn extra_screens_are_only_allowed_when_the_switch_is_exactly_one() {
        use std::ffi::OsStr;
        assert!(allows_extra_screens(Some(OsStr::new("1"))));
        assert!(!allows_extra_screens(None));
        assert!(!allows_extra_screens(Some(OsStr::new("0"))));
        assert!(!allows_extra_screens(Some(OsStr::new("true"))));
        assert!(!allows_extra_screens(Some(OsStr::new(""))));
    }

    #[test]
    fn other_windows_are_only_allowed_when_the_switch_is_exactly_one() {
        use std::ffi::OsStr;
        assert!(allows_other_windows(Some(OsStr::new("1"))));
        assert!(!allows_other_windows(None));
        assert!(!allows_other_windows(Some(OsStr::new("0"))));
    }

    #[test]
    fn finds_remote_control_and_screen_sharing_apps() {
        let (forbidden, browsers) = split(&[
            "bash",
            "TeamViewer.exe",
            "AnyDesk",
            "zoom.us",
            "obs64.exe",
            "gnome-shell",
        ]);
        assert_eq!(forbidden, ["anydesk", "obs64", "teamviewer", "zoom"]);
        assert!(browsers.is_empty());
    }

    #[test]
    fn finds_browsers_once_however_many_processes_they_have() {
        let (forbidden, browsers) = split(&[
            "chrome",
            "chrome",
            "chrome_crashpad_handler",
            "firefox",
            "msedge.exe",
        ]);
        assert!(forbidden.is_empty());
        assert_eq!(browsers, ["chrome", "firefox", "msedge"]);
    }

    #[test]
    fn finds_other_visible_windows_but_not_our_own_minimized_or_untitled_ones() {
        let windows = [
            (100, "Firefox".to_string(), false),
            (100, "Firefox".to_string(), false), // same app, two windows - deduped
            (200, String::new(), false),         // no title - ignored
            (300, "Telegram".to_string(), true), // minimized - ignored
            (999, "KompyuterMagi".to_string(), false), // our own pid - ignored
        ];
        assert_eq!(classify_windows(999, windows.into_iter()), ["Firefox"]);
    }

    #[test]
    fn leaves_ordinary_apps_alone() {
        let (forbidden, browsers) = split(&[
            "telegram-deskto",
            "code",
            "obsidian",
            "discord",
            "slack",
            "magi-desktop",
            "peekaboo",
        ]);
        assert!(forbidden.is_empty());
        assert!(browsers.is_empty());
    }
}
