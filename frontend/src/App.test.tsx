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
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(() => Promise.resolve()) }));

import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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

describe("App", () => {
  it("shows only an Update button when a newer version is out, never the sign in", async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    vi.mocked(check).mockResolvedValueOnce({ version: "9.9.9", downloadAndInstall } as never);
    render(<App />);

    expect(await screen.findByText(/9\.9\.9/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign In" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled());
    expect(downloadAndInstall).toHaveBeenCalled();
  });

  it("goes on to sign in when the update check fails", async () => {
    vi.mocked(check).mockRejectedValueOnce(new Error("offline"));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();
  });

  it("signs in and shows the exam list, with no sidebar at all", async () => {
    queueFetch([
      { status: 200, body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } } },
      { status: 200, body: { success: true, exams: [] } },
      { status: 200, body: { success: true, message: "Logged out" } },
    ]);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign In" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await screen.findByText("No exams assigned yet.");
    expect(screen.queryByRole("navigation")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));
    await screen.findByRole("heading", { name: "Sign In" });
  });

  it("hides the header and footer while an exam is open", async () => {
    const exam = { id: 15, name: "Test Exam", kind: "exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2099-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 };
    const attempt = {
      id: 28, exam_id: 15, status: "in_progress", started_at: null, submitted_at: null, auto_submitted: false,
      session_duration: 60, session_duration_unit: "seconds", expires_at: "2099-01-01T00:01:00Z", remaining_seconds: 60, late_seconds: 0, unlimited_time: false, exam,
      questions: [{
        question_id: 26, position: 1, title: "Q1", question: "Is this a test?", question_type: "multiple_choice",
        expected_duration: 60, expected_duration_unit: "seconds", marks: 10,
        options: [{ id: 51, option_text: "Yes" }, { id: 52, option_text: "No" }],
        answer: "", selected_option_ids: [], typing_duration: 0, typing_duration_unit: "seconds",
        text_typed: 0, text_edited: 0, text_pasted: 0, paste_events: 0, text_deleted: 0, freeze_count: 0, longest_freeze: 0, started_at: null, answered_at: null, last_synced_at: null,
      }],
      permitted_urls: [],
    };
    queueFetch([
      { status: 200, body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } } },
      { status: 200, body: { success: true, exams: [exam] } },
      { status: 200, body: { success: true, attempt } },
      { status: 200, body: { success: true, synced: 1, remaining_seconds: 55, late_seconds: 0 } },
      { status: 200, body: { success: true, attempt: { ...attempt, status: "submitted", submitted_at: "2026-01-01T00:00:10Z", remaining_seconds: 0 }, message: "ok" } },
    ]);

    render(<App />);
    fireEvent.change(await screen.findByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(screen.getByText("MAGI Desktop").closest("header")).toHaveProperty("hidden", true);
    fireEvent.click(await screen.findByRole("button", { name: "Begin" }));
    await screen.findByText("Is this a test?");

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
    await screen.findByText("Your answers were submitted.");
    expect(screen.getByText("MAGI Desktop").closest("header")).toHaveProperty("hidden", false);
  });
});
