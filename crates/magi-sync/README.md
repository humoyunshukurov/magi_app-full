# magi-sync

Backend REST client and the persistent retry queue (ADR-0004). Handles the launch `claim`
flow, heartbeats, dossier submit, and exponential-backoff retry (1s→2s→…cap 5min, jittered).

TLS is rustls via `reqwest`; verification is never disabled. Tokens live in the OS keychain,
never on disk. M0 ships the crate skeleton; the client lands in M3.
