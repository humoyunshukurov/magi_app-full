// What the student did during an attempt, written to the encrypted local log and read back by
// the Activity page.

import { z } from "zod";
import type { ActivityEvent } from "./generated/ActivityEvent";
import { activityLog } from "./ipc";
import { reportCheating, uploadMedia, type CheatingType } from "./api";

export type ActivityKind =
  | "attempt_started"
  | "attempt_resumed"
  | "question_opened"
  | "question_summary"
  | "paste"
  | "window_left"
  | "window_returned"
  | "sync_failed"
  | "sync_recovered"
  | "drafts_restored"
  | "attempt_submitted"
  | "auto_submitted"
  | "submit_failed"
  | "camera_on"
  | "camera_off"
  | "camera_failed"
  | "camera_checks_off"
  | "camera_away"
  | "camera_back"
  | "mic_on"
  | "mic_off"
  | "mic_failed"
  | "phone_seen"
  | "talking"
  | "looking_away"
  | "devtools_attempt"
  | "monitor_added"
  | "monitor_removed"
  | "app_detected"
  | "link_opened"
  | "link_closed"
  | "link_blocked"
  | "identity_check"
  | "identity_check_failed"
  | "extra_person"
  | "screenshot"
  | "screenshot_failed"
  | "app_closed";

export interface ActivityContext {
  userId: number;
  token: string;
  attemptId: number;
  examName: string;
}

// local-only kinds that double as a proctoring violation: synced to the server too, so staff
// can see them without the student's own machine (the rest only ever goes to the local log)
const CHEATING_KIND: Partial<Record<ActivityKind, CheatingType>> = {
  paste: "copy_paste",
  window_left: "tab_switch_limit",
  devtools_attempt: "devtools",
  monitor_added: "multiple_monitors",
  app_detected: "unauthorized_app",
  link_blocked: "link_blocked",
  app_closed: "app_closed",
  camera_away: "camera_away",
  phone_seen: "phone_seen",
  extra_person: "extra_person",
  talking: "talking",
  looking_away: "looking_away",
};

// kinds whose `data.image` is a suspicious-moment photo worth keeping on the server too
const PHOTO_KIND = new Set<ActivityKind>(["phone_seen", "camera_away", "extra_person", "talking", "looking_away", "screenshot"]);

// a proctoring sync (cheating report, snapshot upload) is worth one retry after a transient
// network blip before giving up - still fire-and-forget from the caller's point of view
function syncOnce<T>(label: string, run: () => Promise<T>) {
  run().catch((err) => {
    console.error(`${label} failed, retrying once:`, err);
    run().catch((retryErr) => console.error(`${label} failed again, giving up:`, retryErr));
  });
}

/** Records one entry. A failing local store (or a failed server sync) never gets in the way of
 * the exam - but every failure is at least logged, instead of disappearing silently. */
export function logActivity(
  ctx: ActivityContext,
  kind: ActivityKind,
  detail: string,
  extra: { questionId?: number; data?: Record<string, unknown> } = {},
) {
  const event: ActivityEvent = {
    user_id: ctx.userId,
    attempt_id: ctx.attemptId,
    exam_name: ctx.examName,
    at: new Date().toISOString(),
    kind,
    question_id: extra.questionId ?? null,
    detail,
    data: JSON.stringify(extra.data ?? {}),
  };
  syncOnce(`activityLog(${kind})`, () => activityLog(event));

  const cheatingType = CHEATING_KIND[kind];
  if (cheatingType) {
    syncOnce(`reportCheating(${cheatingType})`, () => reportCheating(ctx.token, ctx.attemptId, cheatingType, detail));
  }

  const image = extra.data?.image;
  if (PHOTO_KIND.has(kind) && typeof image === "string") {
    syncOnce(`uploadMedia(${kind})`, () => uploadMedia(ctx.token, ctx.attemptId, "snapshots", image, detail));
  }
}

/** The counters carried by a `question_summary` entry. */
export const questionSummarySchema = z.object({
  label: z.string(),
  position: z.number(),
  typed: z.number(),
  edited: z.number(),
  pasted: z.number(),
  typing_seconds: z.number(),
  time_spent_seconds: z.number(),
  answered: z.boolean(),
});
export type QuestionSummary = z.infer<typeof questionSummarySchema>;

/** Parses an entry's `data` as JSON, or null if it isn't valid. */
export function parseData<T extends z.ZodTypeAny>(schema: T, data: string): z.infer<T> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
