import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttemptSession, SYNC_IDLE_MS, type AttemptView } from "./AttemptSession";
import { syncAnswers, submitAttempt } from "./api";
import { activityLog, appQuit, cameraStart, draftClear, draftLoad, draftSave, environmentCheck, examLock, linkClose, linkOpen, onCloseAttempt, onLinkBlocked, onLinkClosed, onLinkFocus, onWindowFocusChanged, screenshotTake } from "./ipc";
import { LINK_GRACE_MS, POLL_MS, QUIT_DELAY_MS, SHOT_DELAY_MS, SHOT_GAP_MS, SHOT_LIMIT } from "./useExamGuard";

vi.mock("./cameraWatch", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cameraWatch")>()), loadDetector: () => new Promise(() => {}) }));
vi.mock("./ipc", () => ({
  draftSave: vi.fn(),
  draftLoad: vi.fn(),
  draftClear: vi.fn(),
  activityLog: vi.fn(),
  cameraStart: vi.fn(),
  cameraStop: vi.fn(),
  onCameraFrame: vi.fn(),
  onCameraLost: vi.fn(),
  environmentCheck: vi.fn(),
  examLock: vi.fn(),
  linkOpen: vi.fn(),
  linkClose: vi.fn(),
  onLinkFocus: vi.fn(),
  onLinkClosed: vi.fn(),
  onLinkBlocked: vi.fn(),
  onWindowFocusChanged: vi.fn(),
  screenshotTake: vi.fn(),
  appQuit: vi.fn(),
  onCloseAttempt: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  syncAnswers: vi.fn(),
  submitAttempt: vi.fn(),
  getAttempt: vi.fn(),
}));

const exam = { id: 15, name: "Writing Test", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2027-01-01T00:00:00Z", status: "ongoing" as const, max_marks: 20, passing_marks: 10 };

const question = (over: Partial<AttemptView["questions"][number]>): AttemptView["questions"][number] => ({
  question_id: 1, position: 1, title: "Q", question: "Explain.", question_type: "essay", expected_duration: 300,
  expected_duration_unit: "seconds", marks: 10, options: [], answer: "", selected_option_ids: [], typing_duration: 0,
  typing_duration_unit: "seconds", text_typed: 0, text_edited: 0, text_pasted: 0, text_deleted: 0, freeze_count: 0,
  longest_freeze: 0, started_at: null, answered_at: null, last_synced_at: null, ...over,
});

const attempt = (remaining_seconds = 600): AttemptView => ({
  id: 77, exam_id: 15, status: "in_progress", started_at: null, submitted_at: null, auto_submitted: false,
  session_duration: 600, session_duration_unit: "seconds", expires_at: "2026-01-01T00:10:00Z", remaining_seconds, exam,
  questions: [
    question({ question_id: 1, position: 1, title: "Essay", question: "Explain.", question_type: "essay" }),
    question({ question_id: 2, position: 2, title: "Choice", question: "Pick one.", question_type: "multiple_choice", options: [{ id: 5, option_text: "A" }, { id: 6, option_text: "B" }] }),
  ],
  permitted_urls: [],
});

const finished = { ...attempt(), status: "graded" as const, score: 10, passed: true };

const logged = (kind: string) => vi.mocked(activityLog).mock.calls.map(([event]) => event).filter((event) => event.kind === kind);
const dataOf = (event: { data: string } | undefined) => JSON.parse(event?.data ?? "{}") as Record<string, unknown>;

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// There's no `.value`/`.selectionStart` on a contenteditable div the way there was on the old
// `<textarea>`, so AnswerSheet stashes its live Tiptap editor on the element itself for tests.
function editorOf(box: HTMLElement) {
  return (box as unknown as { __editor: { commands: { insertContent: (t: string) => void; setTextSelection: (r: { from: number; to: number }) => void } } }).__editor;
}

function type(box: HTMLElement, text: string, inputType = "insertText") {
  fireEvent(box, new InputEvent("beforeinput", { inputType, data: text, bubbles: true, cancelable: true }));
  editorOf(box).commands.insertContent(text);
}

/** Moves the cursor (or selects a range) by character offset, as if this were still a plain textarea. */
function selectChars(box: HTMLElement, start: number, end = start) {
  // a single paragraph's text starts at document position 1, not 0
  editorOf(box).commands.setTextSelection({ from: start + 1, to: end + 1 });
}

function renderSession(a = attempt(), resumed = false) {
  const onFinished = vi.fn();
  render(<AttemptSession userId={7} token="tok" attempt={a} resumed={resumed} onFinished={onFinished} />);
  return onFinished;
}

const oneScreen = { monitor_count: 1, extra_screens_allowed: false, forbidden_apps: [], browsers: [], other_windows: [], other_windows_allowed: false };
const link: { focus?: (focused: boolean) => void; closed?: () => void; blocked?: (url: string) => void; closeAttempt?: () => void } = {};
const win: { focusChanged?: (focused: boolean) => void } = {};

/** The exam window gaining or losing OS focus - the native event `useExamGuard` listens to now, not DOM blur/focus. */
const blur = () => act(() => win.focusChanged?.(false));
const focusWindow = () => act(() => win.focusChanged?.(true));

const cameraTrack = { label: "Integrated Camera", stop: vi.fn(), addEventListener: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [cameraTrack], getVideoTracks: () => [cameraTrack] }) },
    configurable: true,
  });
  vi.mocked(cameraStart).mockResolvedValue(null);
  vi.mocked(environmentCheck).mockResolvedValue(oneScreen);
  vi.mocked(examLock).mockResolvedValue(undefined);
  vi.mocked(linkOpen).mockResolvedValue(undefined);
  vi.mocked(linkClose).mockResolvedValue(undefined);
  vi.mocked(onLinkFocus).mockImplementation((handler) => {
    link.focus = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onWindowFocusChanged).mockImplementation((handler) => {
    win.focusChanged = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onLinkClosed).mockImplementation((handler) => {
    link.closed = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(screenshotTake).mockResolvedValue("SHOT");
  vi.mocked(appQuit).mockResolvedValue(undefined);
  vi.mocked(onCloseAttempt).mockImplementation((handler) => {
    link.closeAttempt = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(onLinkBlocked).mockImplementation((handler) => {
    link.blocked = handler;
    return Promise.resolve(() => undefined);
  });
  vi.mocked(draftLoad).mockResolvedValue([]);
  vi.mocked(draftSave).mockResolvedValue(undefined);
  vi.mocked(draftClear).mockResolvedValue(undefined);
  vi.mocked(activityLog).mockResolvedValue(undefined);
  vi.mocked(syncAnswers).mockResolvedValue({ synced: 1, remaining_seconds: 600 });
  vi.mocked(submitAttempt).mockResolvedValue({ attempt: finished, message: "ok" });
});

// Unmounting logs too, so it has to happen before the mocks are cleared.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AttemptSession", () => {
  it("keeps every keystroke locally and only syncs after ten idle seconds", async () => {
    renderSession();
    await flush();
    const box = screen.getByLabelText("Your answer");

    type(box, "h");
    type(box, "i");
    expect(draftSave).toHaveBeenLastCalledWith(expect.objectContaining({ attempt_id: 77, question_id: 1, answer: "<p>hi</p>", text_typed: 2 }));
    expect(syncAnswers).not.toHaveBeenCalled();

    await advance(SYNC_IDLE_MS - 1);
    expect(syncAnswers).not.toHaveBeenCalled();
    await advance(1);
    expect(syncAnswers).toHaveBeenCalledTimes(1);
    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [
      expect.objectContaining({ question_id: 1, answer: "<p>hi</p>", text_typed: 2, text_edited: 0, text_pasted: 0, typing_duration_unit: "seconds" }),
    ]);
  });

  it("keeps waiting while the student keeps typing", async () => {
    renderSession();
    await flush();
    const box = screen.getByLabelText("Your answer");
    type(box, "a");
    await advance(SYNC_IDLE_MS - 1000);
    type(box, "b");
    await advance(SYNC_IDLE_MS - 1000);
    expect(syncAnswers).not.toHaveBeenCalled();
    await advance(1000);
    expect(syncAnswers).toHaveBeenCalledTimes(1);
  });

  it("counts typed and edited text separately", async () => {
    renderSession();
    await flush();
    const box = screen.getByLabelText("Your answer");

    type(box, "abc");
    selectChars(box, 1);
    type(box, "X");

    await advance(SYNC_IDLE_MS);
    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [
      expect.objectContaining({ text_typed: 4, text_edited: 1, text_pasted: 0 }),
    ]);
  });

  it("restores drafts from the local store and pushes them to the server", async () => {
    vi.mocked(draftLoad).mockResolvedValue([
      { attempt_id: 77, question_id: 1, answer: "half-written", option_ids: [], typing_duration: 20, text_typed: 30, text_edited: 2, text_pasted: 0, text_deleted: 0, freeze_count: 0, longest_freeze: 0, time_spent: 60, started_at: "2026-09-28T10:00:00.000Z", answered_at: null },
    ]);
    renderSession();
    await flush();

    expect(screen.getByLabelText("Your answer").textContent).toBe("half-written");
    await advance(SYNC_IDLE_MS);
    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [
      expect.objectContaining({ question_id: 1, answer: "half-written", text_typed: 30, text_edited: 2, typing_duration: 20 }),
    ]);
  });

  it("carries on when the local store is unavailable", async () => {
    vi.mocked(draftLoad).mockRejectedValue(new Error("local storage is unavailable"));
    vi.mocked(draftSave).mockRejectedValue(new Error("local storage is unavailable"));
    renderSession();
    await flush();

    type(screen.getByLabelText("Your answer"), "still works");
    await advance(SYNC_IDLE_MS);
    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [expect.objectContaining({ answer: "<p>still works</p>" })]);
  });

  it("sends the answers right away when moving to another question", async () => {
    renderSession();
    await flush();
    type(screen.getByLabelText("Your answer"), "done here");

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();

    expect(syncAnswers).toHaveBeenCalledTimes(1);
    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [expect.objectContaining({ question_id: 1, answer: "<p>done here</p>" })]);
    expect(screen.getByText("Pick one.")).toBeTruthy();
  });

  it("saves what was typed and submits by itself when the time runs out", async () => {
    const onFinished = renderSession(attempt(5));
    await flush();
    type(screen.getByLabelText("Your answer"), "late answer");

    await advance(5000);
    await flush();

    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [expect.objectContaining({ answer: "<p>late answer</p>" })]);
    expect(submitAttempt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncAnswers).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(submitAttempt).mock.invocationCallOrder[0]!);
    expect(onFinished).toHaveBeenCalledWith(finished, "timeout");
    expect(draftClear).toHaveBeenCalledWith(77);
  });

  it("flushes, submits and clears the local drafts on Submit", async () => {
    const onFinished = renderSession();
    await flush();
    type(screen.getByLabelText("Your answer"), "final");
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
    await flush();

    expect(syncAnswers).toHaveBeenCalledWith("tok", 77, [expect.objectContaining({ answer: "<p>final</p>" })]);
    expect(submitAttempt).toHaveBeenCalledWith("tok", 77);
    expect(onFinished).toHaveBeenCalledWith(finished, undefined);
    expect(draftClear).toHaveBeenCalledWith(77);
  });

  it("doesn't submit when the answers couldn't be saved, and says so", async () => {
    vi.mocked(syncAnswers).mockRejectedValue(new Error("offline"));
    const onFinished = renderSession();
    await flush();
    type(screen.getByLabelText("Your answer"), "unsaved");
    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
    await flush();

    expect(submitAttempt).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
    expect(screen.getByText(/Couldn't save your answers/)).toBeTruthy();
  });

  it("shows a countdown", async () => {
    renderSession(attempt(125));
    await flush();
    expect(screen.getByRole("timer").textContent).toBe("02:05");
    await advance(5000);
    expect(screen.getByRole("timer").textContent).toBe("02:00");
  });

  describe("activity log", () => {
    it("records the start of the attempt, with the order the questions came in", async () => {
      renderSession();
      await flush();

      const [started] = logged("attempt_started");
      expect(started).toMatchObject({ user_id: 7, attempt_id: 77, exam_name: "Writing Test" });
      expect(dataOf(started)).toEqual({ question_count: 2, order: ["Essay", "Choice"] });
      expect(logged("question_opened")[0]).toMatchObject({ question_id: 1, detail: "Opened question 1 (essay)" });
    });

    it("turns the camera on with the exam, records it, and turns it off when the exam is closed", async () => {
      const { unmount } = render(<AttemptSession userId={7} token="tok" attempt={attempt()} onFinished={vi.fn()} />);
      await flush();

      expect(screen.getByText("Camera on")).toBeTruthy();
      expect(logged("camera_on")[0]).toMatchObject({ user_id: 7, attempt_id: 77, detail: "Camera on: Integrated Camera" });

      unmount();
      expect(cameraTrack.stop).toHaveBeenCalled();
      expect(logged("camera_off")).toHaveLength(1);
    });

    it("carries on, and records it, when there is no camera", async () => {
      Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn().mockRejectedValue(new DOMException("none", "NotFoundError")) }, configurable: true });
      renderSession();
      await flush();

      expect(screen.getByRole("alert").textContent).toContain("NotFoundError");
      expect(logged("camera_failed")).toHaveLength(1);
      expect(screen.getByLabelText("Your answer")).toBeTruthy();
    });

    it("records how much was answered when the exam is handed in", async () => {
      renderSession();
      await flush();
      type(screen.getByLabelText("Your answer"), "hello");
      fireEvent.click(screen.getByRole("button", { name: "Next →" }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
      await flush();

      const [submitted] = logged("attempt_submitted");
      expect(dataOf(submitted)).toEqual({ answered: 1, total: 2, marks_answered: 10, marks_total: 20 });
    });

    it("writes the ID number and photo from the check before the exam to the log", async () => {
      const checkIn = {
        idNumber: "AB1234567",
        photo: "data:image/jpeg;base64,FACE",
        notes: [{ kind: "screenshot_failed" as const, detail: "Couldn't take a screenshot: x" }],
      };
      render(<AttemptSession userId={7} token="tok" attempt={attempt()} checkIn={checkIn} onFinished={vi.fn()} />);
      await flush();

      expect(logged("identity_check")[0]).toMatchObject({ user_id: 7, attempt_id: 77, detail: "ID number AB1234567, photo taken before the exam" });
      expect(dataOf(logged("identity_check")[0])).toEqual({ id_number: "AB1234567", image: "data:image/jpeg;base64,FACE" });
      expect(logged("screenshot_failed")[0]).toMatchObject({ detail: "Couldn't take a screenshot: x" });
    });

    it("writes the ID number even when there was no camera", async () => {
      render(<AttemptSession userId={7} token="tok" attempt={attempt()} checkIn={{ idNumber: "AB1", photo: null, notes: [] }} onFinished={vi.fn()} />);
      await flush();

      expect(logged("identity_check")[0]).toMatchObject({ detail: "ID number AB1, no photo (no camera)" });
      expect(dataOf(logged("identity_check")[0])).toEqual({ id_number: "AB1" });
    });

    it("writes no identity check when an exam that was already running is picked up again", async () => {
      render(<AttemptSession userId={7} token="tok" attempt={attempt()} resumed checkIn={{ idNumber: "", photo: null, notes: [] }} onFinished={vi.fn()} />);
      await flush();

      expect(logged("identity_check")).toHaveLength(0);
    });

    it("records a resumed attempt as resumed, not as a fresh start", async () => {
      renderSession(attempt(), true);
      await flush();

      expect(logged("attempt_started")).toHaveLength(0);
      const [resumed] = logged("attempt_resumed");
      expect(resumed).toMatchObject({ detail: expect.stringContaining("Resumed") });
      expect(dataOf(resumed)).toEqual({ question_count: 2, order: ["Essay", "Choice"] });
    });

    it("says when saved answers were restored after a restart", async () => {
      vi.mocked(draftLoad).mockResolvedValue([
        { attempt_id: 77, question_id: 1, answer: "half", option_ids: [], typing_duration: 1, text_typed: 4, text_edited: 0, text_pasted: 0, text_deleted: 0, freeze_count: 0, longest_freeze: 0, time_spent: 5, started_at: null, answered_at: null },
      ]);
      renderSession();
      await flush();
      expect(logged("drafts_restored")).toHaveLength(1);
    });

    it("sums a question up when the student leaves it", async () => {
      renderSession();
      await flush();
      type(screen.getByLabelText("Your answer"), "hello");
      await advance(3000);

      fireEvent.click(screen.getByRole("button", { name: "Next →" }));
      await flush();

      const [summary] = logged("question_summary");
      expect(summary).toMatchObject({ question_id: 1 });
      expect(dataOf(summary)).toEqual({
        label: "Question 1 (essay)", position: 1, typed: 5, edited: 0, deleted: 0, pasted: 0, typing_seconds: 0,
        freeze_count: 0, longest_freeze_seconds: 0, time_spent_seconds: 3, answered: true,
      });
    });

    it("holds back text pasted from outside the exam, and records the try", async () => {
      renderSession();
      await flush();

      const allowed = fireEvent.paste(document.body, { clipboardData: { getData: () => "twelve chars" } });

      expect(allowed).toBe(false);
      expect(logged("paste")[0]).toMatchObject({ question_id: 1, detail: "Tried to paste 12 characters from outside the exam into question 1 (essay) (blocked)" });
      expect(dataOf(logged("paste")[0])).toEqual({ chars: 12 });
    });

    it("lets text that was copied inside the exam be pasted inside the exam, without a word in the log", async () => {
      renderSession();
      await flush();
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Explain." } as Selection);

      expect(fireEvent.copy(document.body)).toBe(true);
      expect(fireEvent.paste(document.body, { clipboardData: { getData: () => "Explain." } })).toBe(true);

      expect(logged("paste")).toHaveLength(0);
      expect(logged("copy")).toHaveLength(0);
    });

    it("lets text be cut from the answer and put back", async () => {
      renderSession();
      await flush();
      const box = screen.getByLabelText("Your answer");
      type(box, "my own words");
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "own" } as Selection);

      // ProseMirror's own clipboard handling prevents the raw cut/paste event itself (it
      // does its own serialization instead), so the return value here isn't a signal of
      // anything — what matters is that our guard doesn't ALSO block it, i.e. nothing logged.
      fireEvent.cut(box);
      fireEvent.paste(box, { clipboardData: { getData: () => "own" } });
      expect(logged("paste")).toHaveLength(0);
    });

    it("holds back a paste that isn't what was copied inside, even after something was copied", async () => {
      renderSession();
      await flush();
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Explain." } as Selection);
      fireEvent.copy(document.body);

      const allowed = fireEvent.paste(document.body, { clipboardData: { getData: () => "answer from a website" } });

      expect(allowed).toBe(false);
      expect(logged("paste")).toHaveLength(1);
    });

    it("counts lines that end differently as the same text", async () => {
      renderSession();
      await flush();
      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "one\ntwo" } as Selection);
      fireEvent.copy(document.body);

      expect(fireEvent.paste(document.body, { clipboardData: { getData: () => "one\r\ntwo" } })).toBe(true);
    });

    it("doesn't count pasting nothing", async () => {
      renderSession();
      await flush();

      expect(fireEvent.paste(document.body, { clipboardData: { getData: () => "" } })).toBe(true);
      expect(logged("paste")).toHaveLength(0);
    });

    it("holds back text dropped in from outside, lets text dragged inside be dropped, and holds back the right-click menu", async () => {
      renderSession();
      await flush();

      expect(fireEvent.drop(document.body, { dataTransfer: { getData: () => "dropped" } })).toBe(false);
      expect(logged("paste")[0]).toMatchObject({ detail: "Tried to drop 7 characters from outside the exam into question 1 (essay) (blocked)" });

      vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "dragged" } as Selection);
      fireEvent.dragStart(document.body);
      expect(fireEvent.drop(document.body, { dataTransfer: { getData: () => "dragged" } })).toBe(true);

      expect(fireEvent.drop(document.body, { dataTransfer: { getData: () => "", files: [{}] } })).toBe(false);
      expect(fireEvent.contextMenu(document.body)).toBe(false);
      expect(logged("paste")).toHaveLength(1);
    });

    it("holds the developer tools shortcuts back and records the try", async () => {
      renderSession();
      await flush();

      expect(fireEvent.keyDown(document.body, { key: "F12" })).toBe(false);
      expect(fireEvent.keyDown(document.body, { key: "I", ctrlKey: true, shiftKey: true })).toBe(false);
      expect(fireEvent.keyDown(document.body, { key: "u", ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(document.body, { key: "a" })).toBe(true);

      expect(logged("devtools_attempt").map((e) => e.detail)).toEqual([
        "Tried to open the developer tools (F12) (blocked)",
        "Tried to open the developer tools (Ctrl+Shift+I) (blocked)",
        "Tried to open the developer tools (Ctrl+U) (blocked)",
      ]);
    });

    it("ends the exam automatically the moment the student leaves the window", async () => {
      const onFinished = renderSession();
      await flush();

      blur();
      blur();
      await flush();

      expect(logged("window_left")).toHaveLength(1);
      expect(submitAttempt).toHaveBeenCalledWith("tok", 77);
      expect(logged("auto_submitted")[0]).toMatchObject({
        detail: "Left the exam window - the attempt was submitted automatically and the exam ended",
      });
      expect(onFinished).toHaveBeenCalledWith(finished, "left_window");
    });

    it("still records coming back, even though leaving already ended the attempt", async () => {
      renderSession();
      await flush();

      blur();
      await advance(7000);
      focusWindow();

      expect(dataOf(logged("window_returned")[0])).toEqual({ away_seconds: 7 });
    });

    it("logs a lost connection once, and again when it is back", async () => {
      vi.mocked(syncAnswers).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
      renderSession();
      await flush();
      type(screen.getByLabelText("Your answer"), "text");

      await advance(SYNC_IDLE_MS);
      await advance(SYNC_IDLE_MS);
      expect(logged("sync_failed")).toHaveLength(1);
      expect(logged("sync_recovered")).toHaveLength(0);

      await advance(SYNC_IDLE_MS);
      expect(logged("sync_recovered")).toHaveLength(1);
    });

    it("records a manual submit, with the last question summed up first", async () => {
      // a single question, so it's the last one already - no navigating away from another
      // question first, which would add its own summary on top of the one this test checks for
      const single = { ...attempt(), questions: [question({ question_id: 1, position: 1, title: "Essay", question: "Explain.", question_type: "essay" })] };
      renderSession(single);
      await flush();
      type(screen.getByLabelText("Your answer"), "final");

      fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
      await flush();

      expect(logged("question_summary")).toHaveLength(1);
      expect(logged("attempt_submitted")).toHaveLength(1);
      expect(logged("auto_submitted")).toHaveLength(0);
    });

    it("records a timeout as an automatic submit", async () => {
      renderSession(attempt(5));
      await flush();

      await advance(5000);
      await flush();

      expect(logged("auto_submitted")).toHaveLength(1);
      expect(logged("attempt_submitted")).toHaveLength(0);
    });

    it("records a submit that could not go through", async () => {
      vi.mocked(syncAnswers).mockRejectedValue(new Error("offline"));
      renderSession();
      await flush();
      type(screen.getByLabelText("Your answer"), "unsaved");
      fireEvent.click(screen.getByRole("button", { name: "Next →" }));
      await flush();

      fireEvent.click(screen.getByRole("button", { name: "Submit attempt" }));
      await flush();

      expect(logged("submit_failed")).toHaveLength(1);
    });
  });

  describe("guard", () => {
    const withLinks = () => ({ ...attempt(), permitted_urls: [{ id: 1, url: "https://docs.example.com/guide" }, { id: 2, url: "https://example.org/ref" }] });

    it("goes full screen for the exam and back when it is closed", async () => {
      const { unmount } = render(<AttemptSession userId={7} token="tok" attempt={attempt()} onFinished={vi.fn()} />);
      await flush();
      expect(examLock).toHaveBeenCalledWith(true);

      unmount();
      expect(examLock).toHaveBeenLastCalledWith(false);
      expect(linkClose).toHaveBeenCalled();
    });

    it("says nothing while there is one screen and nothing forbidden", async () => {
      renderSession();
      await flush();
      await advance(POLL_MS * 3);

      expect(environmentCheck).toHaveBeenCalledTimes(4);
      for (const kind of ["monitor_added", "monitor_removed", "app_detected"]) expect(logged(kind)).toHaveLength(0);
    });

    it("records a second screen connected in the middle of the exam, and its removal", async () => {
      vi.mocked(environmentCheck).mockResolvedValueOnce(oneScreen).mockResolvedValueOnce({ ...oneScreen, monitor_count: 2 }).mockResolvedValue(oneScreen);
      renderSession();
      await flush();
      await advance(POLL_MS);
      expect(logged("monitor_added")[0]).toMatchObject({ detail: "A screen was connected during the exam (2 now)" });
      expect(dataOf(logged("monitor_added")[0])).toEqual({ monitors: 2 });

      await advance(POLL_MS);
      expect(logged("monitor_removed")[0]).toMatchObject({ detail: "A screen was disconnected (1 now)" });
    });

    it("records more than one screen that was already there when the exam opened", async () => {
      vi.mocked(environmentCheck).mockResolvedValue({ ...oneScreen, monitor_count: 2 });
      renderSession();
      await flush();
      await advance(POLL_MS * 2);

      expect(logged("monitor_added")).toHaveLength(1);
      expect(logged("monitor_added")[0]).toMatchObject({ detail: "More than one screen is connected (2)" });
    });

    it("records a forbidden app that starts, and a browser that is opened, once each", async () => {
      vi.mocked(environmentCheck)
        .mockResolvedValueOnce({ ...oneScreen, browsers: ["chrome"] })
        .mockResolvedValue({ ...oneScreen, forbidden_apps: ["anydesk"], browsers: ["chrome", "firefox"] });
      renderSession();
      await flush();
      await advance(POLL_MS * 3);

      expect(logged("app_detected").map((e) => e.detail)).toEqual(["A forbidden app was started: anydesk", "A browser was opened: firefox"]);
    });

    it("doesn't count the extra screen a developer's computer always has, but still counts one that is added", async () => {
      const allowed = { ...oneScreen, monitor_count: 2, extra_screens_allowed: true };
      vi.mocked(environmentCheck).mockResolvedValueOnce(allowed).mockResolvedValueOnce(allowed).mockResolvedValue({ ...allowed, monitor_count: 3 });
      renderSession();
      await flush();
      await advance(POLL_MS);
      expect(logged("monitor_added")).toHaveLength(0);

      await advance(POLL_MS);
      expect(logged("monitor_added")[0]).toMatchObject({ detail: "A screen was connected during the exam (3 now)" });
    });

    it("records a forbidden app that was already running when the exam was picked up again", async () => {
      vi.mocked(environmentCheck).mockResolvedValue({ ...oneScreen, forbidden_apps: ["teamviewer"] });
      renderSession();
      await flush();

      expect(logged("app_detected")[0]).toMatchObject({ detail: "A forbidden app is running: teamviewer" });
    });

    it("lists the permitted links and opens one in its own window", async () => {
      renderSession(withLinks());
      await flush();

      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();

      expect(linkOpen).toHaveBeenCalledWith("https://example.org/ref", ["https://docs.example.com/guide", "https://example.org/ref"]);
      expect(logged("link_opened")[0]).toMatchObject({ detail: "Opened the permitted link https://example.org/ref" });
    });

    it("shows no links panel when the exam has none", async () => {
      renderSession();
      await flush();
      expect(screen.queryByText("Permitted links:")).toBeNull();
    });

    it("doesn't count going to the permitted link's window as leaving the exam", async () => {
      renderSession(withLinks());
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();

      blur(); // the exam window loses focus...
      act(() => link.focus?.(true)); // ...to the link window
      await advance(LINK_GRACE_MS * 2);

      expect(logged("window_left")).toHaveLength(0);
    });

    it("counts leaving the permitted link's window for somewhere else", async () => {
      renderSession(withLinks());
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();
      blur();
      act(() => link.focus?.(true));
      await advance(LINK_GRACE_MS * 2);

      act(() => link.focus?.(false));
      await advance(LINK_GRACE_MS * 2);

      expect(logged("window_left")).toHaveLength(1);
    });

    it("doesn't count hopping from the link window back to the exam", async () => {
      renderSession(withLinks());
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();
      blur();
      act(() => link.focus?.(true));
      await advance(LINK_GRACE_MS * 2);

      act(() => link.focus?.(false));
      focusWindow();
      await advance(LINK_GRACE_MS * 2);

      expect(logged("window_left")).toHaveLength(0);
    });

    it("records how long the permitted link was open, and a try to go somewhere else from it", async () => {
      renderSession(withLinks());
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();
      await advance(12_000);

      act(() => link.blocked?.("https://elsewhere.test/"));
      act(() => link.closed?.());

      expect(logged("link_blocked")[0]).toMatchObject({ detail: "The permitted link tried to go to https://elsewhere.test/ (blocked)" });
      expect(logged("link_closed")[0]).toMatchObject({ detail: "Closed the permitted link after 12 s" });
    });

    it("takes a screenshot when the student leaves the exam window", async () => {
      renderSession();
      await flush();

      blur();
      expect(screenshotTake).not.toHaveBeenCalled();
      await advance(SHOT_DELAY_MS);

      expect(screenshotTake).toHaveBeenCalledTimes(1);
      expect(logged("screenshot")[0]).toMatchObject({ question_id: 1, detail: "Screenshot after leaving the exam window" });
      expect(dataOf(logged("screenshot")[0])).toEqual({ image: "data:image/jpeg;base64,SHOT", reason: "window_left" });
    });

    it("doesn't take a screenshot for going to a permitted link", async () => {
      renderSession(withLinks());
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();
      blur();
      act(() => link.focus?.(true));
      await advance(SHOT_DELAY_MS * 2);

      expect(screenshotTake).not.toHaveBeenCalled();
    });

    it("doesn't take screenshots in a burst", async () => {
      renderSession();
      await flush();

      for (let i = 0; i < 3; i++) {
        blur();
        await advance(SHOT_DELAY_MS);
        focusWindow();
        await advance(1000);
      }
      expect(screenshotTake).toHaveBeenCalledTimes(1);

      await advance(SHOT_GAP_MS);
      blur();
      await advance(SHOT_DELAY_MS);
      expect(screenshotTake).toHaveBeenCalledTimes(2);
    });

    it("stops taking screenshots after the limit", async () => {
      renderSession();
      await flush();

      for (let i = 0; i < SHOT_LIMIT + 3; i++) {
        blur();
        await advance(SHOT_DELAY_MS);
        focusWindow();
        await advance(SHOT_GAP_MS);
      }
      expect(screenshotTake).toHaveBeenCalledTimes(SHOT_LIMIT);
    });

    it("writes it down when a screenshot can't be taken", async () => {
      vi.mocked(screenshotTake).mockRejectedValue("the screenshot wasn't allowed");
      renderSession();
      await flush();

      blur();
      await advance(SHOT_DELAY_MS);

      expect(logged("screenshot")).toHaveLength(0);
      expect(logged("screenshot_failed")[0]).toMatchObject({ detail: "Couldn't take a screenshot: the screenshot wasn't allowed" });
      expect(logged("window_left")).toHaveLength(1);
    });

    it("writes down a try to close the app, takes a screenshot, and then lets it close", async () => {
      renderSession();
      await flush();

      act(() => link.closeAttempt?.());
      await flush();
      expect(logged("app_closed")[0]).toMatchObject({ detail: "Tried to close the app during the exam" });
      expect(dataOf(logged("screenshot")[0])).toEqual({ image: "data:image/jpeg;base64,SHOT", reason: "app_closed" });
      expect(appQuit).not.toHaveBeenCalled();

      await advance(QUIT_DELAY_MS);
      expect(appQuit).toHaveBeenCalledTimes(1);
    });

    it("takes the screenshot for a closing app even right after another one", async () => {
      renderSession();
      await flush();
      blur();
      await advance(SHOT_DELAY_MS);

      act(() => link.closeAttempt?.());
      await flush();

      expect(screenshotTake).toHaveBeenCalledTimes(2);
    });

    it("still lets the app close when the screenshot can't be taken", async () => {
      vi.mocked(screenshotTake).mockRejectedValue("no");
      renderSession();
      await flush();

      act(() => link.closeAttempt?.());
      await flush();
      await advance(QUIT_DELAY_MS);

      expect(logged("screenshot_failed")).toHaveLength(1);
      expect(appQuit).toHaveBeenCalledTimes(1);
    });

    it("forgets a link that couldn't be opened", async () => {
      vi.mocked(linkOpen).mockRejectedValue("that link isn't permitted for this exam");
      renderSession(withLinks());
      await flush();

      fireEvent.click(screen.getByRole("button", { name: "https://example.org/ref" }));
      await flush();
      blur();
      await advance(LINK_GRACE_MS);

      expect(logged("link_opened")).toHaveLength(0);
      expect(logged("window_left")).toHaveLength(1);
    });
  });
});
