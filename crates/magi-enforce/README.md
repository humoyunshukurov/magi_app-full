# magi-enforce

Platform-specific enforcement, feature-gated per OS and per integrity level (ADR-0002).

- Level 2 (Guarded): system-proxy network whitelist (ADR-0005) — M4
- Level 3 (Lockdown): kiosk window, clipboard ingress block, app-switch interception — M5

M0 ships the crate skeleton and feature flags only; no enforcement is active.
