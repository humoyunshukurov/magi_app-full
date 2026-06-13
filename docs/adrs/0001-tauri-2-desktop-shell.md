# ADR-0001 — Use Tauri 2 for the desktop shell

**Status:** Accepted

Mirror of the [Notion ADR](https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b);
Notion is the source of truth.

### Context
We need a cross-platform desktop app with serious OS-level access (network proxy, kiosk mode,
clipboard, app switching). Three reasonable shells: Electron, Tauri, fully native
(Swift + WPF + GTK).

### Decision
Use **Tauri 2**.

### Rationale
- Bundle size: Tauri ships ~10–20 MB vs Electron's 100+ MB. Matters for students on low-end laptops.
- Memory: system webview saves ~100–200 MB idle RAM vs bundled Chromium.
- Our actual logic lives in Rust; Tauri puts Rust at the center, Electron makes it a sidecar.
- Tauri 2 has first-class plugins for the OS-level needs (clipboard, single-instance, updater).
- Fully native triples v1 implementation cost for minimal user-visible benefit.

### Trade-offs accepted
- WebView quirks across platforms (Safari / WebView2 / WebKitGTK) — mitigated by a small compat
  shim and CI on all three.
- Smaller community than Electron — mitigated by the strong Rust ecosystem.
