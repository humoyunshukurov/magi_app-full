import { vi } from "vitest";
import "./i18n";

// plugin-http needs tauri, use plain fetch in tests
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}));
