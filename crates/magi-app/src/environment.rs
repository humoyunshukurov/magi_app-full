//! What is running on the student's computer: how many screens are connected, and whether an
//! app that could help cheat (remote control, screen sharing or recording) or a browser is open.
//! Read before an exam starts and again every few seconds while it runs.

use magi_types::EnvironmentReport;
use sysinfo::{ProcessesToUpdate, System};

/// Remote control and screen sharing/recording tools, matched on the start of the process name.
/// Messengers are left out on purpose: plenty of students have one open all day. Parsec is left
/// out too: macOS ships its own unrelated system daemon under the identical process name
/// (`parsecd`, reportedly behind Siri/Spotlight suggestions), so this flagged it on every Mac
/// regardless of whether the real app was even installed.
const FORBIDDEN_PREFIXES: &[&str] = &[
    "teamviewer",
    "anydesk",
    "rustdesk",
    "ultraviewer",
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

/// A window that's really the OS shell's own always-on-screen furniture - macOS's compositor, or
/// the hidden desktop/taskbar host `explorer.exe` keeps around on Windows - not something the
/// student opened and could switch to. Matched on both the owning app's name and the window's own
/// title, so a genuine window from the same app (an actual File Explorer folder, say) still gets
/// caught: only `explorer.exe`'s titleless housekeeping window is exempt, not every one of its
/// windows.
fn is_shell_window(app_name: &str, title: &str) -> bool {
    match app_name {
        "Window Server" => true,
        "Windows Explorer" => title.trim().is_empty(),
        _ => false,
    }
}

/// Names of other apps' visible windows, given each window's owning pid, app name, title, and
/// whether it's minimized - pulled out so the filtering can be tested without a real window list.
/// Only `other_windows()` below calls it for real, on the platforms that have one.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux", test))]
fn classify_windows(our_pid: u32, windows: impl Iterator<Item = (u32, String, String, bool)>) -> Vec<String> {
    let mut names: Vec<String> = windows
        .filter(|(pid, app_name, title, minimized)| {
            *pid != our_pid
                && !*minimized
                && !(app_name.trim().is_empty() && title.trim().is_empty())
                && !is_shell_window(app_name, title)
        })
        .map(|(_, app_name, title, _)| if !app_name.trim().is_empty() { app_name } else { title })
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Every other app's windows need to be closed before an exam starts, so there's nothing easy to
/// switch to - checked where the OS actually allows one app to see another's windows. Windows and
/// macOS have no Wayland-style blind spot, so `process_names` (Linux's fallback - see below) goes
/// unused here.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn other_windows(_process_names: &[String]) -> Vec<String> {
    let Ok(windows) = xcap::Window::all() else {
        return Vec::new();
    };
    let our_pid = std::process::id();
    let info = windows.iter().map(|w| {
        let app_name = w.app_name().ok().filter(|s| !s.is_empty()).unwrap_or_default();
        let title = w.title().unwrap_or_default();
        (w.pid().unwrap_or(our_pid), app_name, title, w.is_minimized().unwrap_or(false))
    });
    classify_windows(our_pid, info)
}

/// Editors, office suites and other everyday apps that are neither a browser (its own exemption,
/// since plenty of students have one open for something legitimate) nor a messenger (same reason)
/// - the names a Wayland-native process still shows up under in `/proc`, used as a fallback where
/// the window list below can't see it at all. Checked by exact name: most of these binaries are
/// short enough that a prefix match would catch unrelated processes.
const COMMON_NON_BROWSER_APPS: &[&str] = &[
    "code",
    "code-insiders",
    "codium",
    "cursor",
    "sublime_text",
    "atom",
    "notepad++",
    "gedit",
    "kate",
    "soffice.bin",
];

/// Process-name fallback for `other_windows` - catches a Wayland-native app's process even when
/// the window list below can't see its window at all (see that function's doc comment). Not a
/// full fix: it only knows the apps named above, not arbitrary ones, but it closes the exact gap
/// that let a student leave an editor open during the test10 attempt.
fn other_window_processes<'a>(names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut found: Vec<String> = names
        .map(plain)
        .filter(|name| COMMON_NON_BROWSER_APPS.contains(&name.as_str()))
        .collect();
    found.sort();
    found.dedup();
    found
}

/// Same idea on Linux, talking to X11/XWayland directly (`_NET_CLIENT_LIST` on the root window,
/// `_NET_WM_PID`/`WM_CLASS`/`_NET_WM_STATE` per window - the same properties `xcap` itself reads,
/// without pulling in its unconditional Linux `pipewire` dependency for a Wayland video-recording
/// feature this never uses).
///
/// **Confirmed gap on a pure-Wayland desktop, now covered for known apps**: a native Wayland
/// client (confirmed here with Firefox and Telegram, both running as Wayland-native apps) never
/// registers with X11 at all, so it is invisible to the window list below; an XWayland-backed app
/// (older Electron builds, some GTK3 apps, this app's own WebKitGTK window) still shows up.
/// `other_window_processes` above closes this for the apps named in `COMMON_NON_BROWSER_APPS` by
/// checking `/proc` instead, which doesn't care which display protocol a process drew its window
/// with. Windows and macOS have no such split, so they don't need the fallback.
#[cfg(target_os = "linux")]
fn other_windows(process_names: &[String]) -> Vec<String> {
    use xcb::x::{Atom, GetProperty, InternAtom, Window, ATOM_ATOM, ATOM_CARDINAL, ATOM_NONE, ATOM_STRING, ATOM_WM_CLASS};

    fn atom(conn: &xcb::Connection, name: &str) -> Option<Atom> {
        let cookie = conn.send_request(&InternAtom { only_if_exists: true, name: name.as_bytes() });
        match conn.wait_for_reply(cookie) {
            Ok(reply) if reply.atom() != ATOM_NONE => Some(reply.atom()),
            _ => None,
        }
    }

    // X11/XWayland may not even be reachable on a pure-Wayland session - that just means this
    // part contributes nothing, not that the whole check should give up (the process fallback
    // below still runs).
    let via_x11: Vec<String> = (|| {
        let (conn, screen_idx) = xcb::Connection::connect(None).ok()?;
        let root = conn.get_setup().roots().nth(screen_idx as usize).map(|s| s.root())?;
        let client_list = atom(&conn, "_NET_CLIENT_LIST")?;

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

            // X11's WM_CLASS gives one name, not a separate app-name/title split like xcap does -
            // passed as both, same as before this needed splitting at all (is_shell_window only
            // ever matches macOS/Windows app names, so this is a no-op here).
            (pid, name.clone(), name, minimized)
        });

        Some(classify_windows(our_pid, info))
    })()
    .unwrap_or_default();

    let mut all = via_x11;
    all.extend(other_window_processes(process_names.iter().map(String::as_str)));
    all.sort();
    all.dedup();
    all
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
        other_windows: other_windows(&names),
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
            (100, "Firefox".to_string(), String::new(), false),
            (100, "Firefox".to_string(), String::new(), false), // same app, two windows - deduped
            (200, String::new(), String::new(), false),         // no title - ignored
            (300, "Telegram".to_string(), String::new(), true), // minimized - ignored
            (999, "KompyuterMagi".to_string(), String::new(), false), // our own pid - ignored
        ];
        assert_eq!(classify_windows(999, windows.into_iter()), ["Firefox"]);
    }

    #[test]
    fn exempts_only_the_os_shell_s_own_housekeeping_window_not_every_window_it_owns() {
        let windows = [
            (100, "Window Server".to_string(), String::new(), false), // macOS's own compositor
            (200, "Windows Explorer".to_string(), String::new(), false), // the hidden desktop/taskbar host
            (300, "Windows Explorer".to_string(), "Documents".to_string(), false), // a real folder window
        ];
        assert_eq!(classify_windows(999, windows.into_iter()), ["Windows Explorer"]);
    }

    #[test]
    fn is_shell_window_only_matches_known_shell_app_names() {
        assert!(is_shell_window("Window Server", ""));
        assert!(is_shell_window("Windows Explorer", ""));
        assert!(is_shell_window("Windows Explorer", "   "));
        assert!(!is_shell_window("Windows Explorer", "Documents"));
        assert!(!is_shell_window("Firefox", ""));
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

    #[test]
    fn catches_a_wayland_native_editor_by_process_name_even_with_no_window_list() {
        // what the window-list check on Linux can't see for a Wayland-native app (see
        // other_windows' doc comment) - this is exactly what let test10 through
        assert_eq!(other_window_processes(["Code", "magi-desktop"].into_iter()), ["code"]);
    }

    #[test]
    fn process_fallback_leaves_browsers_and_messengers_alone() {
        // deliberately exempt elsewhere (students legitimately have these open) - the fallback
        // must not quietly start blocking on them
        assert!(other_window_processes(["firefox", "chrome", "telegram-desktop", "discord"].into_iter()).is_empty());
    }
}
