import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GradesPage } from "./GradesPage";
import { listMyAttempts, type AttemptSummary } from "./api";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listMyAttempts: vi.fn(),
}));

const EXAM = { id: 1, name: "Algorithms", scheduled_start: "", scheduled_end: "", status: "completed" as const, max_marks: 100, passing_marks: 50 };

function attempt(overrides: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    id: 1,
    exam_id: 1,
    status: "submitted",
    started_at: null,
    submitted_at: null,
    auto_submitted: false,
    session_duration: 3600,
    session_duration_unit: "seconds",
    expires_at: "",
    remaining_seconds: 0,
    exam: EXAM,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GradesPage", () => {
  it("shows Loading while the request is in flight", () => {
    vi.mocked(listMyAttempts).mockReturnValue(new Promise(() => {}));
    render(<GradesPage token="tok" visible />);

    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("does not leave 'Loading…' on screen once the request has failed", async () => {
    vi.mocked(listMyAttempts).mockRejectedValue(new Error("network down"));
    render(<GradesPage token="tok" visible />);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not load your grades"));

    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("shows the empty state once attempts have loaded and there are none", async () => {
    vi.mocked(listMyAttempts).mockResolvedValue([]);
    render(<GradesPage token="tok" visible />);

    await waitFor(() => expect(screen.getByText("You haven't started an exam yet.")).toBeTruthy());
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("lists an attempt once loaded, without an error box", async () => {
    vi.mocked(listMyAttempts).mockResolvedValue([attempt({ status: "submitted" })]);
    render(<GradesPage token="tok" visible />);

    await waitFor(() => expect(screen.getByText("Algorithms")).toBeTruthy());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
