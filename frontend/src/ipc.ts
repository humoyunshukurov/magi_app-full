// Typed IPC boundary (ADR-0002). Every payload crossing Tauri IPC is validated at runtime
// with zod, and each schema is tied to the Rust-generated type via `satisfies`, so drift
// between `magi-types` and the frontend is a compile error.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { z } from "zod";
import type { ActivityEvent } from "./generated/ActivityEvent";
import type { AnswerDraft } from "./generated/AnswerDraft";
import type { EnvironmentReport } from "./generated/EnvironmentReport";
import type { PingResponse } from "./generated/PingResponse";

/** Runtime schema for the `ping` command result, pinned to the generated `PingResponse`. */
export const pingResponseSchema = z.object({
  message: z.string(),
  core_version: z.string(),
}) satisfies z.ZodType<PingResponse>;

/** Call the `ping` IPC command and validate the response. */
export async function ping(): Promise<PingResponse> {
  const raw = await invoke("ping");
  return pingResponseSchema.parse(raw);
}

/** Payload emitted by the Rust deep-link handler on `magi://launch…` (ADR-0010). */
export const launchPayloadSchema = z.object({
  token: z.string().nullable(),
  exam_id: z.number().nullable(),
});

export type LaunchPayload = z.infer<typeof launchPayloadSchema>;

/** Event name the Rust core emits launch hand-offs on. */
export const LAUNCH_EVENT = "launch://received" as const;

/** Runtime schema for a stored answer draft, pinned to the generated `AnswerDraft`. */
export const answerDraftSchema = z.object({
  attempt_id: z.number(),
  question_id: z.number(),
  answer: z.string(),
  option_ids: z.array(z.number()),
  typing_duration: z.number(),
  text_typed: z.number(),
  text_edited: z.number(),
  text_pasted: z.number(),
  paste_events: z.number(),
  text_deleted: z.number(),
  freeze_count: z.number(),
  longest_freeze: z.number(),
  time_spent: z.number(),
  started_at: z.string().nullable(),
  answered_at: z.string().nullable(),
}) satisfies z.ZodType<AnswerDraft>;

/** Writes (or replaces) the encrypted local draft of one question. */
export async function draftSave(draft: AnswerDraft): Promise<void> {
  await invoke("draft_save", { draft });
}

/** Every local draft of an attempt. */
export async function draftLoad(attemptId: number): Promise<AnswerDraft[]> {
  return z.array(answerDraftSchema).parse(await invoke("draft_load", { attemptId }));
}

/** Drops the local drafts of an attempt once it has been submitted. */
export async function draftClear(attemptId: number): Promise<void> {
  await invoke("draft_clear", { attemptId });
}

/** Runtime schemas for the Activity log, pinned to the generated types. */
export const activityEventSchema = z.object({
  user_id: z.number(),
  attempt_id: z.number(),
  exam_name: z.string(),
  at: z.string(),
  kind: z.string(),
  question_id: z.number().nullable(),
  detail: z.string(),
  data: z.string(),
}) satisfies z.ZodType<ActivityEvent>;

/** Appends one entry to the encrypted local activity log. */
export async function activityLog(event: ActivityEvent): Promise<void> {
  await invoke("activity_log", { event });
}

/**
 * Starts the camera. A name means the app itself is reading it and pushes the frames (Linux);
 * null means the webview can open the camera by itself.
 */
export async function cameraStart(): Promise<string | null> {
  return z.string().nullable().parse(await invoke("camera_start"));
}

export async function cameraStop(): Promise<void> {
  await invoke("camera_stop");
}

/** Each frame the app reads from the camera, as a base64 JPEG. Resolves to the unsubscribe function. */
export const onCameraFrame = (handler: (jpegBase64: string) => void) => listen<string>("camera-frame", (e) => handler(e.payload));

export const onCameraLost = (handler: (reason: string) => void) => listen<string>("camera-lost", (e) => handler(e.payload));

const environmentReportSchema = z.object({
  monitor_count: z.number(),
  extra_screens_allowed: z.boolean(),
  forbidden_apps: z.array(z.string()),
  browsers: z.array(z.string()),
  other_windows: z.array(z.string()),
  other_windows_allowed: z.boolean(),
}) satisfies z.ZodType<EnvironmentReport>;

/** How many screens are connected and which forbidden apps and browsers are running. */
export async function environmentCheck(): Promise<EnvironmentReport> {
  return environmentReportSchema.parse(await invoke("environment_check"));
}

/** Full screen for as long as an exam is open. */
export async function examLock(on: boolean): Promise<void> {
  await invoke("exam_lock", { on });
}

/** Opens a permitted link in its own window; `permitted` is every link the exam allows. */
export async function linkOpen(url: string, permitted: string[]): Promise<void> {
  await invoke("link_open", { url, permitted });
}

export async function linkClose(): Promise<void> {
  await invoke("link_close");
}

export const onLinkFocus = (handler: (focused: boolean) => void) => listen<boolean>("link-focus", (e) => handler(e.payload));
export const onLinkClosed = (handler: () => void) => listen("link-closed", () => handler());
export const onLinkBlocked = (handler: (url: string) => void) => listen<string>("link-blocked", (e) => handler(e.payload));

/** A picture of the whole screen, as a base64 JPEG. The first time, the desktop may ask the student to allow it. */
export async function screenshotTake(): Promise<string> {
  return z.string().parse(await invoke("screenshot_take"));
}

/** Closes the app for real; while an exam is open the window only asks the exam first. */
export async function appQuit(): Promise<void> {
  await invoke("app_quit");
}

export const onCloseAttempt = (handler: () => void) => listen("close-attempt", () => handler());

/**
 * Whether the exam window itself has OS focus - the native window event, not the webview's own
 * `window.blur`/`focus` DOM events, which don't reliably reach the page on every platform.
 */
export const onWindowFocusChanged = (handler: (focused: boolean) => void) => {
  // Unlike `invoke`/`listen`, `getCurrentWindow` throws synchronously (not a rejected promise)
  // outside a real Tauri webview - caught here so callers can treat this like every other
  // `on*` subscription above and just `.catch()` it.
  try {
    return getCurrentWindow().onFocusChanged((e) => handler(e.payload));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
};
