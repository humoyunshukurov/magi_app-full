import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("./PreExam", async () => {
  const { createElement } = await import("react");
  return {
    PreExam: ({ onReady }: { onReady: (c: { photos: never[]; notes: never[] }) => void }) =>
      createElement("button", { onClick: () => onReady({ photos: [], notes: [] }) }, "Begin"),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  ping: vi.fn(() => Promise.resolve({ message: "pong", core_version: "0.0.0" })),
}));

import { App } from "./App";

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
  vi.clearAllMocks();
  localStorage.clear();
});

describe("App navigation", () => {
  it("offers Exams and Grades only while signed in", async () => {
    queueFetch([
      { status: 200, body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } } },
      { status: 200, body: { success: true, exams: [] } },
      { status: 200, body: { success: true, message: "Logged out" } },
    ]);

    render(<App />);
    await screen.findByText(/pong/);
    expect(screen.getByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Grades" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await screen.findByRole("button", { name: "Grades" });
    expect(screen.getByRole("button", { name: "Exams" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("heading", { name: "Sign In" });
    expect(screen.queryByRole("button", { name: "Grades" })).toBeNull();
  });

  it("takes the sidebar away while an exam is open", async () => {
    const exam = { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 };
    const attempt = {
      id: 28, exam_id: 15, status: "in_progress", started_at: null, submitted_at: null, auto_submitted: false,
      session_duration: 60, session_duration_unit: "seconds", expires_at: "2099-01-01T00:01:00Z", remaining_seconds: 60, exam,
      questions: [{
        question_id: 26, position: 1, title: "Q1", question: "Is this a test?", question_type: "multiple_choice",
        expected_duration: 60, expected_duration_unit: "seconds", marks: 10,
        options: [{ id: 51, option_text: "Yes" }, { id: 52, option_text: "No" }],
        answer: "", selected_option_ids: [], typing_duration: 0, typing_duration_unit: "seconds",
        text_typed: 0, text_edited: 0, text_pasted: 0, started_at: null, answered_at: null, last_synced_at: null,
      }],
      permitted_urls: [],
    };
    queueFetch([
      { status: 200, body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } } },
      { status: 200, body: { success: true, exams: [exam] } },
      { status: 200, body: { success: true, attempt } },
      { status: 200, body: { success: true, synced: 1, remaining_seconds: 55 } },
      { status: 200, body: { success: true, attempt: { ...attempt, status: "submitted", submitted_at: "2026-01-01T00:00:10Z", remaining_seconds: 0 }, message: "ok" } },
    ]);

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    // the checks before the exam count too
    expect(screen.queryByRole("button", { name: "Grades" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Begin" }));
    await screen.findByText("Is this a test?");

    expect(screen.queryByRole("button", { name: "Grades" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Exams" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
    await screen.findByText("Your answers were submitted.");
    expect(screen.getByRole("button", { name: "Grades" })).toBeTruthy();
  });

  it("shows a graded exam's score and feedback on the Grades page", async () => {
    const exam = { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 };
    const gradedAttempt = {
      id: 90, exam_id: 15, status: "graded", started_at: null, submitted_at: "2026-01-01T00:10:00Z", auto_submitted: false,
      session_duration: 60, session_duration_unit: "seconds", expires_at: "2026-01-01T00:11:00Z", remaining_seconds: 0, exam,
      score: 8, passed: true, feedback: "Clear and well argued.",
    };
    queueFetch([
      { status: 200, body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } } },
      { status: 200, body: { success: true, exams: [exam] } },
      { status: 200, body: { success: true, attempts: [gradedAttempt] } },
    ]);

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    fireEvent.click(await screen.findByRole("button", { name: "Grades" }));
    await screen.findByText("Your exam was graded");
    expect(screen.getByText("8/10")).toBeTruthy();
    // shown both in the "new grade" banner and the persistent attempts list below it
    expect(screen.getAllByText(/Clear and well argued/).length).toBeGreaterThan(0);
  });
});
