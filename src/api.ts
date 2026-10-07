// Typed client for magi-server (ADR-0004: REST + bearer auth), same ADR-0002 pattern as
// `ipc.ts` - every response is validated at runtime with zod, pinned to the ts-rs-generated
// type via `satisfies` wherever that type is actually correct for what's on the wire.
//
// One place that pattern breaks: ts-rs maps Rust's `i64` (every id, `remaining_seconds`, …)
// to TS `bigint`, but serde_json serializes it as a plain JSON number, not a bigint literal.
// `z.bigint()` would reject every real response, so ids are `z.number()` here and the
// `satisfies` check is dropped for the types that carries one - the schema below is what
// actually arrives, not what the generated `.ts` file claims.

import { z } from "zod";
import type { ExamStatus } from "./generated/ExamStatus";
import type { AttemptStatus } from "./generated/AttemptStatus";
import type { TimeUnit } from "./generated/TimeUnit";
import type { QuestionType } from "./generated/QuestionType";
import type { CheatingType } from "./generated/CheatingType";

const BASE_URL = import.meta.env.VITE_MAGI_SERVER_URL ?? "http://localhost:8081";

function apiResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({ success: z.boolean(), data: data.optional(), message: z.string().optional() });
}

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

async function fetchEnvelope<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit | undefined,
  token: string | undefined,
): Promise<{ success: boolean; data?: T; message?: string }> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers }).catch((err: unknown) => {
    throw new ApiError(`Could not reach magi-server at ${BASE_URL}: ${String(err)}`, "network");
  });
  const json: unknown = await res.json().catch(() => null);
  const parsed = apiResponseSchema(schema).safeParse(json);
  if (!parsed.success) {
    throw new ApiError(`Unexpected response shape from ${path}: ${parsed.error.message}`, "response");
  }
  return parsed.data;
}

/** For endpoints that answer their payload in `data` on success. */
async function requestData<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, token?: string): Promise<T> {
  const envelope = await fetchEnvelope(path, schema, init, token);
  if (!envelope.success || envelope.data === undefined) {
    throw new ApiError(envelope.message ?? `Request to ${path} failed`, "response");
  }
  return envelope.data;
}

/** For endpoints that only ever answer `{success, message}` on success - signup, logout, … */
async function requestMessage(path: string, init?: RequestInit, token?: string): Promise<string> {
  const envelope = await fetchEnvelope(path, z.never().optional(), init, token);
  if (!envelope.success) {
    throw new ApiError(envelope.message ?? `Request to ${path} failed`, "response");
  }
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

const loginResponseSchema = z.object({ token: z.string(), user: userSummarySchema });

export async function signup(body: { first_name: string; last_name?: string; email: string; password: string }) {
  return requestMessage("/api/auth/signup", { method: "POST", body: JSON.stringify(body) });
}

export async function login(email: string, password: string) {
  return requestData("/api/auth/login", loginResponseSchema, { method: "POST", body: JSON.stringify({ email, password }) });
}

export async function logout(token: string) {
  return requestMessage("/api/auth/logout", { method: "POST" }, token);
}

export async function me(token: string) {
  return requestData("/api/auth/me", userSummarySchema, { method: "GET" }, token);
}

const examStatusSchema = z.enum(["demo", "scheduled", "ongoing", "completed", "delayed", "cancelled"]) satisfies z.ZodType<ExamStatus>;

const permittedUrlSchema = z.object({ id: z.number(), url: z.string() });

const attemptStatusSchema = z.enum(["pending", "in_progress", "submitted", "auto_submitted", "graded", "flagged"]) satisfies z.ZodType<AttemptStatus>;

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
  return requestData("/api/exams", z.array(examSummarySchema), { method: "GET" }, token);
}

export async function getExam(token: string, examId: number) {
  return requestData(`/api/exams/${examId}`, examDetailSchema, { method: "GET" }, token);
}

const timeUnitSchema = z.enum(["seconds", "minutes", "hours", "days"]) satisfies z.ZodType<TimeUnit>;
const questionTypeSchema = z.enum(["multiple_choice", "true_false", "short_answer", "essay"]) satisfies z.ZodType<QuestionType>;

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
  return requestData("/api/attempts", attemptDetailSchema, { method: "POST", body: JSON.stringify({ exam_id: examId }) }, token);
}

/** Every attempt this student has, most recent first - including graded ones with their score/feedback. */
export async function listMyAttempts(token: string) {
  return requestData("/api/attempts/my", z.array(attemptSummarySchema), { method: "GET" }, token);
}

export async function getAttempt(token: string, attemptId: number) {
  return requestData(`/api/attempts/${attemptId}`, attemptDetailSchema, { method: "GET" }, token);
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

const syncAnswersResponseSchema = z.object({ synced: z.number(), remaining_seconds: z.number() });

export async function syncAnswers(token: string, attemptId: number, answers: AnswerInput[]) {
  return requestData(
    `/api/attempts/${attemptId}/answers`,
    syncAnswersResponseSchema,
    { method: "PUT", body: JSON.stringify({ answers }) },
    token,
  );
}

const submitResponseSchema = z.object({ attempt: attemptSummarySchema, message: z.string() });

export async function submitAttempt(token: string, attemptId: number) {
  return requestData(`/api/attempts/${attemptId}/submit`, submitResponseSchema, { method: "POST" }, token);
}

const cheatingRecordSchema = z.object({ id: z.number(), name: z.string(), explanation: z.string(), created_at: z.string() });

/** Records an auto-detected incident server-side, so staff can see it on the attempt without the student's own machine. */
export async function reportCheating(token: string, attemptId: number, name: CheatingType, explanation: string) {
  return requestData(
    `/api/cheatings/attempts/${attemptId}`,
    cheatingRecordSchema,
    { method: "POST", body: JSON.stringify({ name, explanation }) },
    token,
  );
}

export type MonitoringKind = "panoramic-views" | "video-recordings" | "face-snapshots" | "snapshots";
const mediaRecordSchema = z.object({ id: z.number(), url: z.string(), label: z.string().nullable(), created_at: z.string() });

/** Uploads one photo (a `data:image/jpeg;base64,...` string) so staff can see it without the student's own machine. */
export async function uploadMedia(token: string, attemptId: number, kind: MonitoringKind, image: string, label?: string) {
  return requestData(
    `/api/monitoring/attempts/${attemptId}/${kind}`,
    mediaRecordSchema,
    { method: "POST", body: JSON.stringify({ image, label }) },
    token,
  );
}
