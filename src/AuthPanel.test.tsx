// Drives the whole student flow through the actual rendered UI (login -> exam list -> start
// attempt -> answer -> submit -> graded result), against a mocked fetch queue shaped exactly
// like magi-server's real responses. This is what stands in for a browser here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthPanel } from "./AuthPanel";

function queueFetch(responses: Array<{ status: number; body: unknown }>) {
  const queue = [...responses];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() => {
      const next = queue.shift();
      if (!next) throw new Error("fetch called more times than expected");
      return Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body) } as Response);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthPanel", () => {
  it("logs in, lists exams, starts an attempt, answers, and submits to a graded result", async () => {
    queueFetch([
      // POST /api/auth/login
      {
        status: 200,
        body: {
          success: true,
          data: { token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } },
        },
      },
      // GET /api/exams
      {
        status: 200,
        body: { success: true, data: [{ id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 }] },
      },
      // POST /api/attempts
      {
        status: 200,
        body: {
          success: true,
          data: {
            id: 28, exam_id: 15, status: "in_progress", started_at: null, submitted_at: null, auto_submitted: false,
            session_duration: 60, session_duration_unit: "seconds", expires_at: "2026-01-01T00:01:00Z", remaining_seconds: 60,
            exam: { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 },
            questions: [{
              question_id: 26, position: 1, title: "Q1", question: "Is this a test?", question_type: "multiple_choice",
              expected_duration: 60, expected_duration_unit: "seconds", marks: 10,
              options: [{ id: 51, option_text: "Yes" }, { id: 52, option_text: "No" }],
              answer: "", selected_option_ids: [], typing_duration: 0, typing_duration_unit: "seconds",
              text_typed: 0, text_edited: 0, text_pasted: 0, started_at: null, answered_at: null, last_synced_at: null,
            }],
            permitted_urls: [],
          },
        },
      },
      // PUT /api/attempts/28/answers
      { status: 200, body: { success: true, data: { synced: 1, remaining_seconds: 55 } } },
      // GET /api/attempts/28 (refresh after answering)
      {
        status: 200,
        body: {
          success: true,
          data: {
            id: 28, exam_id: 15, status: "in_progress", started_at: null, submitted_at: null, auto_submitted: false,
            session_duration: 60, session_duration_unit: "seconds", expires_at: "2026-01-01T00:01:00Z", remaining_seconds: 55,
            exam: { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 },
            questions: [{
              question_id: 26, position: 1, title: "Q1", question: "Is this a test?", question_type: "multiple_choice",
              expected_duration: 60, expected_duration_unit: "seconds", marks: 10,
              options: [{ id: 51, option_text: "Yes" }, { id: 52, option_text: "No" }],
              answer: "", selected_option_ids: [51], typing_duration: 0, typing_duration_unit: "seconds",
              text_typed: 0, text_edited: 0, text_pasted: 0, started_at: null, answered_at: "2026-01-01T00:00:05Z", last_synced_at: "2026-01-01T00:00:05Z",
            }],
            permitted_urls: [],
          },
        },
      },
      // POST /api/attempts/28/submit
      {
        status: 200,
        body: {
          success: true,
          data: {
            attempt: {
              id: 28, exam_id: 15, status: "graded", started_at: null, submitted_at: "2026-01-01T00:00:10Z", auto_submitted: false,
              session_duration: 60, session_duration_unit: "seconds", expires_at: "2026-01-01T00:01:00Z", remaining_seconds: 0,
              exam: { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 },
              score: 10, passed: true,
            },
            message: "Your answers have been submitted",
          },
        },
      },
    ]);

    render(<AuthPanel />);

    fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText(/Test Exam/);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Is this a test?");

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Yes" }).className).toContain("border-magi-primary"));

    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));

    await screen.findByText(/Graded: 10 \/ 10 - passed/);
  });
});
