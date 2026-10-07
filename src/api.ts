// Typed client for magi-backend (the same Node API magi-admin and magi-frontend use) over
// bearer auth: the desktop app can't rely on a browser's cookie jar the way the web apps do,
// so login also returns the session token in the body and every request after that sends
// `Authorization: Bearer <token>` - magi-backend's protectRoute accepts either.
//
// magi-backend's envelope is resource-keyed (`{success, exam}`, `{success, exams}`, …), not a
// uniform `{success, data}` - each function below declares the literal shape its endpoint
// actually returns and unwraps it, so every caller elsewhere in the app still just gets the
// plain value it asks for.

import { z } from "zod";

const BASE_URL = import.meta.env.VITE_MAGI_BACKEND_URL ?? "http://localhost:8000";

/**
 * Thrown for both network failures and `{success: false}` responses - `kind` tells them apart:
 * "network" means the server was never reached (e.g. mid-restart), "response" means it answered
 * and said no (bad credentials, expired token, ...).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "network" | "response",
  ) {
    super(message);
  }
}

const failureSchema = z.object({ success: z.literal(false), message: z.string().optional() });

/** Fetches, then validates the whole response body against `schema` (the literal envelope shape). */
async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers }).catch((err: unknown) => {
    throw new ApiError(`Could not reach the server at ${BASE_URL}: ${String(err)}`, "network");
  });
  const json: unknown = await res.json().catch(() => null);

  const failed = failureSchema.safeParse(json);
  if (failed.success) {
    throw new ApiError(failed.data.message ?? `Request to ${path} failed`, "response");
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(`Unexpected response shape from ${path}: ${parsed.error.message}`, "response");
  }
  return parsed.data;
}

/** For endpoints that only ever answer `{success, message}` on success - signup, logout, … */
async function requestMessage(path: string, init?: RequestInit, token?: string): Promise<string> {
  const schema = z.object({ success: z.literal(true), message: z.string().optional() });
  const envelope = await request(path, schema, init, token);
  return envelope.message ?? "";
}

const userSummarySchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().nullable(),
  email: z.string(),
  role: z.string(),
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export async function signup(body: { first_name: string; last_name?: string; email: string; password: string }) {
  return requestMessage("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({
      firstName: body.first_name,
      lastName: body.last_name,
      email: body.email,
      password: body.password,
      role: "student",
    }),
  });
}

const loginEnvelopeSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  user: userSummarySchema,
});

export async function login(email: string, password: string) {
  const envelope = await request("/api/auth/login", loginEnvelopeSchema, {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return { token: envelope.token, user: envelope.user };
}

export async function logout(token: string) {
  return requestMessage("/api/auth/logout", { method: "POST" }, token);
}

// no envelope at all here - get-user answers the decoded token payload directly
const getUserSchema = userSummarySchema.extend({ iat: z.number().optional(), exp: z.number().optional() });

export async function me(token: string) {
  const user = await request("/api/auth/get-user", getUserSchema, { method: "GET" }, token);
  return { id: user.id, first_name: user.first_name, last_name: user.last_name, email: user.email, role: user.role };
}

const examStatusSchema = z.enum(["demo", "scheduled", "ongoing", "completed", "delayed", "cancelled"]);
const permittedUrlSchema = z.object({ id: z.number(), url: z.string() });
const attemptStatusSchema = z.enum(["pending", "in_progress", "submitted", "auto_submitted", "graded", "flagged"]);

const examSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  scheduled_start: z.string(),
  scheduled_end: z.string(),
  status: examStatusSchema,
  max_marks: z.number(),
  passing_marks: z.number(),
  attempt_status: attemptStatusSchema.nullish(),
});
export type ExamSummary = z.infer<typeof examSummarySchema>;

const examDetailSchema = examSummarySchema.extend({ permitted_urls: z.array(permittedUrlSchema) });

export async function listExams(token: string) {
  const envelope = await request("/api/exams", z.object({ success: z.literal(true), exams: z.array(examSummarySchema) }), { method: "GET" }, token);
  return envelope.exams;
}

export async function getExam(token: string, examId: number) {
  const envelope = await request(`/api/exams/${examId}`, z.object({ success: z.literal(true), exam: examDetailSchema }), { method: "GET" }, token);
  return envelope.exam;
}

const timeUnitSchema = z.enum(["seconds", "minutes", "hours", "days"]);
const questionTypeSchema = z.enum(["multiple_choice", "true_false", "short_answer", "essay"]);

const attemptExamBriefSchema = z.object({
  id: z.number(),
  name: z.string(),
  scheduled_start: z.string(),
  scheduled_end: z.string(),
  status: examStatusSchema,
  max_marks: z.number(),
  passing_marks: z.number(),
});

const attemptSummarySchema = z.object({
  id: z.number(),
  exam_id: z.number(),
  status: attemptStatusSchema,
  started_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  auto_submitted: z.boolean(),
  session_duration: z.number(),
  session_duration_unit: timeUnitSchema,
  expires_at: z.string(),
  remaining_seconds: z.number(),
  exam: attemptExamBriefSchema,
  score: z.number().optional(),
  passed: z.boolean().optional(),
  feedback: z.string().optional(),
});
export type AttemptSummary = z.infer<typeof attemptSummarySchema>;

const attemptQuestionOptionSchema = z.object({ id: z.number(), option_text: z.string() });

const attemptQuestionSchema = z.object({
  question_id: z.number(),
  position: z.number(),
  title: z.string(),
  question: z.string(),
  question_type: questionTypeSchema,
  expected_duration: z.number(),
  expected_duration_unit: timeUnitSchema,
  marks: z.number(),
  options: z.array(attemptQuestionOptionSchema),
  answer: z.string(),
  selected_option_ids: z.array(z.number()),
  typing_duration: z.number(),
  typing_duration_unit: timeUnitSchema,
  text_typed: z.number(),
  text_edited: z.number(),
  text_pasted: z.number(),
  started_at: z.string().nullable(),
  answered_at: z.string().nullable(),
  last_synced_at: z.string().nullable(),
  marks_awarded: z.number().optional(),
});

const attemptDetailSchema = attemptSummarySchema.extend({
  questions: z.array(attemptQuestionSchema),
  permitted_urls: z.array(permittedUrlSchema),
});

export async function startAttempt(token: string, examId: number) {
  const envelope = await request(
    "/api/assignments",
    z.object({ success: z.literal(true), attempt: attemptDetailSchema }),
    { method: "POST", body: JSON.stringify({ examId }) },
    token,
  );
  return envelope.attempt;
}

/** Every attempt this student has, most recent first - including graded ones with their score/feedback. */
export async function listMyAttempts(token: string) {
  const envelope = await request(
    "/api/assignments/my",
    z.object({ success: z.literal(true), attempts: z.array(attemptSummarySchema) }),
    { method: "GET" },
    token,
  );
  return envelope.attempts;
}

export async function getAttempt(token: string, attemptId: number) {
  const envelope = await request(
    `/api/assignments/${attemptId}`,
    z.object({ success: z.literal(true), attempt: attemptDetailSchema }),
    { method: "GET" },
    token,
  );
  return envelope.attempt;
}

export interface AnswerInput {
  question_id: number;
  answer?: string;
  option_ids?: number[];
  typing_duration?: number;
  typing_duration_unit?: TimeUnit;
  text_typed?: number;
  text_edited?: number;
  text_pasted?: number;
  started_at?: string;
  answered_at?: string;
}
export type TimeUnit = z.infer<typeof timeUnitSchema>;

export async function syncAnswers(token: string, attemptId: number, answers: AnswerInput[]) {
  const body = {
    answers: answers.map((a) => ({
      questionId: a.question_id,
      answer: a.answer,
      optionIds: a.option_ids,
      typingDuration: a.typing_duration,
      typingDurationUnit: a.typing_duration_unit,
      textTyped: a.text_typed,
      textEdited: a.text_edited,
      textPasted: a.text_pasted,
      startedAt: a.started_at,
      answeredAt: a.answered_at,
    })),
  };
  const envelope = await request(
    `/api/assignments/${attemptId}/answers`,
    z.object({ success: z.literal(true), synced: z.number(), remaining_seconds: z.number() }),
    { method: "PUT", body: JSON.stringify(body) },
    token,
  );
  return { synced: envelope.synced, remaining_seconds: envelope.remaining_seconds };
}

export async function submitAttempt(token: string, attemptId: number) {
  const envelope = await request(
    `/api/assignments/${attemptId}/submit`,
    z.object({ success: z.literal(true), attempt: attemptSummarySchema, message: z.string() }),
    { method: "POST" },
    token,
  );
  return { attempt: envelope.attempt, message: envelope.message };
}

const cheatingTypeSchema = z.enum([
  "tab_switch_limit",
  "copy_paste",
  "devtools",
  "multiple_monitors",
  "face_mismatch",
  "screen_share",
  "unauthorized_app",
  "manual_review",
  "phone_seen",
  "camera_away",
  "link_blocked",
  "app_closed",
]);
export type CheatingType = z.infer<typeof cheatingTypeSchema>;

/** Records an auto-detected incident server-side, so staff can see it on the attempt without the student's own machine. */
export async function reportCheating(token: string, attemptId: number, name: CheatingType, explanation: string) {
  const envelope = await request(
    `/api/cheatings/attempts/${attemptId}`,
    z.object({
      success: z.literal(true),
      cheating: z.object({ id: z.number(), name: z.string(), explanation: z.string(), created_at: z.string() }),
    }),
    { method: "POST", body: JSON.stringify({ name, explanation }) },
    token,
  );
  return envelope.cheating;
}

export type MonitoringKind = "panoramic-views" | "video-recordings" | "face-snapshots" | "snapshots";
const mediaRecordSchema = z.object({ id: z.number(), url: z.string(), label: z.string().nullable(), created_at: z.string() });

/** Uploads one photo (a `data:image/jpeg;base64,...` string) so staff can see it without the student's own machine. */
export async function uploadMedia(token: string, attemptId: number, kind: MonitoringKind, image: string, label?: string) {
  const envelope = await request(
    `/api/monitoring/attempts/${attemptId}/${kind}`,
    z.object({ success: z.literal(true), media: mediaRecordSchema }),
    { method: "POST", body: JSON.stringify({ image, label }) },
    token,
  );
  return envelope.media;
}
