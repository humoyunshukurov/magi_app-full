# ADR-0008 — Auto-updater channel design

**Status:** Accepted

Mirror of the [Notion ADR](https://app.notion.com/p/048ae832d87f8259908c81dcce1c566b);
Notion is the source of truth.

### Context
Every student runs an installed copy of the desktop app on their own machine. A fix or
feature shipped to `main` is useless until it reaches those machines, and there is no
practical way to walk around re-installing it by hand on every device. The app needs to
update itself.

### Decision
Tauri's built-in updater (`tauri-plugin-updater` + `tauri-plugin-process` for the
post-install relaunch), fed by a static JSON manifest (`latest.json`) published as a
GitHub Release asset in this repo, built and signed by GitHub Actions on every version
tag. The frontend checks once per launch, before the student does anything else, and
installs silently - no prompt, no opt-out.

### Rationale
- **No separate update server.** GitHub Releases already hosts versioned binary
  artifacts for free; `latest.json` is just another asset on the same release, and
  `.../releases/latest/download/latest.json` always resolves to the newest one.
- **No CI secrets beyond what tauri-action needs.** `tauri-apps/tauri-action@v0` builds,
  signs (given `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD`), and publishes the release in one
  step - no separate release pipeline to maintain.
- **Checked at launch, not mid-session.** An update is never applied while a student is
  mid-attempt: the check runs once, in `App.tsx`'s top-level effect, before any exam can
  start. Windows exits the app itself after the installer launches; macOS/Linux need the
  explicit `relaunch()` this ADR's implementation calls after `downloadAndInstall()`.
- **Silent, not prompted.** Proctored exams need everyone on the same version; asking a
  student to choose "later" defeats that, so there is no UI for it.

### Alternatives considered
- **A custom update-check endpoint on magi-backend** — would need its own versioned
  manifest storage and signing, duplicating what GitHub Releases already provides for
  free. Rejected as unnecessary infrastructure.
- **Manual reinstall, communicated out of band** — what the app did before this ADR.
  Doesn't scale past a handful of students and guarantees version drift.
- **Prompting the student to confirm the update** — rejected per the silent-update
  rationale above.

### Implementation notes
- Signing keypair generated with `cargo tauri signer generate`; the public half is
  committed in `src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`, the private half
  lives only as the `TAURI_SIGNING_PRIVATE_KEY` GitHub Actions secret on this repo - never
  committed.
- Release workflow (`.github/workflows/release.yml`) triggers on `v*.*.*` tags.
- `tauri.conf.json`'s `version` and the pushed tag must agree - `tauri-action` reads the
  former to name the release and build the manifest, and failing to bump it means tagging
  a release that reports itself as already-current to every existing install.
