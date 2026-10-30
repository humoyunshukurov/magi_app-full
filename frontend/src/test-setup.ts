import { vi } from "vitest";

// api.ts fetches through @tauri-apps/plugin-http so requests reach the backend from Rust, not
// the webview (see api.ts's import comment) - that plugin calls into a real Tauri runtime
// (window.__TAURI_INTERNALS__), which doesn't exist under jsdom, so tests mock it down to the
// same global fetch every test already stubs with vi.stubGlobal("fetch", ...).
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
