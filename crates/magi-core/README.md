# magi-core

Session lifecycle and the session state machine (ADR-0002). Owns the transitions between
`pending_launch → starting → active → paused → submitting → synced/queued/superseded/failed`
and the rules that govern them.

At M0 this crate exposes only `core_version()` and `ping()` to prove the IPC path end to end.
The state machine lands in M1.
