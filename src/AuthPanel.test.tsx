// Drives the whole student flow through the actual rendered UI (login -> exam list -> start
// attempt -> answer -> submit -> graded result), against a mocked fetch queue shaped exactly
// like magi-server's real responses. This is what stands in for a browser here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthPanel } from "./AuthPanel";

vi.mock("./PreExam", async () => {
  const { createElement } = await import("react");
  return {
    PreExam: ({ withPhotos, onReady, onCancel }: { withPhotos: boolean; onReady: (c: { photos: never[]; notes: never[] }) => void; onCancel: () => void }) =>
      createElement(
        "div",
        null,
        createElement("p", null, `photos: ${withPhotos}`),
        createElement("button", { onClick: () => onReady({ photos: [], notes: [] }) }, "Begin"),
        createElement("button", { onClick: onCancel }, "Cancel check"),
      ),
  };
});

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
  localStorage.clear();
});

const exam = { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 };
const loginResponse = {
  status: 200,
  body: { success: true, token: "tok", user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" } },
};
const examsResponse = { status: 200, body: { success: true, exams: [exam] } };

/** Presses Start (or Resume) and goes through the check before the exam. */
async function begin(name = "Start") {
  fireEvent.click(screen.getByRole("button", { name }));
  fireEvent.click(await screen.findByRole("button", { name: "Begin" }));
}

function signIn() {
  fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "s@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
}

describe("AuthPanel", () => {
  it("logs in, lists exams, starts an attempt, answers, and submits to a graded result", async () => {
    queueFetch([
      // POST /api/auth/login
      {
        status: 200,
        body: {
          success: true,
          token: "tok",
          user: { id: 1, first_name: "Curl", last_name: null, email: "s@example.com", role: "student" },
        },
      },
      // GET /api/exams
      {
        status: 200,
        body: { success: true, exams: [{ id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 }] },
      },
      // POST /api/attempts
      {
        status: 200,
        body: {
          success: true,
          attempt: {
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
      // PUT /api/attempts/28/answers (flushed when the attempt is submitted)
      { status: 200, body: { success: true, synced: 1, remaining_seconds: 55 } },
      // POST /api/attempts/28/submit
      {
        status: 200,
        body: {
          success: true,
          attempt: {
            id: 28, exam_id: 15, status: "graded", started_at: null, submitted_at: "2026-01-01T00:00:10Z", auto_submitted: false,
            session_duration: 60, session_duration_unit: "seconds", expires_at: "2026-01-01T00:01:00Z", remaining_seconds: 0,
            exam: { id: 15, name: "Test Exam", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 10, passing_marks: 5 },
            score: 10, passed: true,
          },
          message: "Your answers have been submitted",
        },
      },
    ]);

    render(<AuthPanel />);

    fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: "s@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Test1234!" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText(/Test Exam/);

    await begin();
    await screen.findByText("Is this a test?");

    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Yes" }).className).toContain("border-magi-primary"));

    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));

    await screen.findByText(/Graded: 10 \/ 10 - passed/);
  });

  it("shows Starting… while the attempt is being created and ignores a second click", async () => {
    const queue = [loginResponse, examsResponse];
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(() => {
      const next = queue.shift();
      return next ? Promise.resolve({ status: next.status, json: () => Promise.resolve(next.body) } as Response) : pending;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthPanel />);
    signIn();
    await screen.findByText(/Test Exam/);

    await begin();
    const starting = await screen.findByRole("button", { name: "Starting…" });
    expect((starting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(starting);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    release({ status: 200, json: () => Promise.resolve({ success: false, message: "stop here" }) } as Response);
    await screen.findByText("stop here");
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  });

  it("says a submitted attempt is waiting to be graded instead of showing a made-up score", async () => {
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
      loginResponse,
      examsResponse,
      { status: 200, body: { success: true, attempt } },
      { status: 200, body: { success: true, synced: 1, remaining_seconds: 55 } },
      {
        status: 200,
        body: { success: true, attempt: { ...attempt, status: "submitted", submitted_at: "2026-01-01T00:00:10Z", remaining_seconds: 0 }, message: "Your answers have been submitted" },
      },
    ]);

    render(<AuthPanel />);
    signIn();
    await screen.findByText(/Test Exam/);
    await begin();
    await screen.findByText("Is this a test?");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));

    await screen.findByText("Your answers were submitted.");
    expect(screen.queryByText(/Graded/)).toBeNull();
  });

  describe("exam list states", () => {
    const listWith = (attempt_status: string | null) => ({
      status: 200,
      body: { success: true, exams: [{ ...exam, attempt_status }] },
    });

    it("shows Start for an exam that was never opened", async () => {
      queueFetch([loginResponse, listWith(null)]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);
      expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    });

    it("shows Resume for an open attempt and picks it up on click", async () => {
      queueFetch([loginResponse, listWith("in_progress"), { status: 200, body: { success: false, message: "stop here" } }]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);
      expect(screen.queryByRole("button", { name: "Start" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await screen.findByText("photos: false"); // an exam already running is only checked, not photographed again
      fireEvent.click(screen.getByRole("button", { name: "Begin" }));
      await screen.findByText("stop here");
    });

    it.each([
      ["submitted", "Submitted"],
      ["auto_submitted", "Submitted"],
      ["graded", "Graded"],
    ])("shows %s as a label, with nothing to click", async (status, label) => {
      queueFetch([loginResponse, listWith(status)]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Start|Resume/ })).toBeNull();
    });

    it("refreshes the list when starting fails, so a stale Start turns into the real state", async () => {
      queueFetch([
        loginResponse,
        listWith(null),
        { status: 409, body: { success: false, message: "You have already completed this exam" } },
        listWith("submitted"),
      ]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);
      await begin();

      await screen.findByText("You have already completed this exam");
      await screen.findByText("Submitted");
      expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    });

    it("fetches the list again when Reload is pressed, so a newly assigned exam shows up", async () => {
      queueFetch([loginResponse, listWith(null), { status: 200, body: { success: true, exams: [exam, { ...exam, id: 16, name: "Second Exam" }] } }]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);
      expect(screen.queryByText("Second Exam")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Reload exams" }));
      await screen.findByText("Second Exam");
    });
  });

  describe("the check before the exam", () => {
    it("goes through the check before anything is started, with photos for a fresh exam", async () => {
      queueFetch([loginResponse, examsResponse]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);

      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      await screen.findByText("photos: true");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2); // login and the exam list: no attempt yet
    });

    it("goes back to the exam list when the check is cancelled", async () => {
      queueFetch([loginResponse, examsResponse]);
      render(<AuthPanel />);
      signIn();
      await screen.findByText(/Test Exam/);

      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel check" }));

      expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
