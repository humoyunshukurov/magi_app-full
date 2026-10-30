import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logActivity, type ActivityContext } from "./activity";
import { activityLog } from "./ipc";
import { reportCheating, uploadMedia } from "./api";

vi.mock("./ipc", () => ({ activityLog: vi.fn() }));
vi.mock("./api", () => ({ reportCheating: vi.fn(), uploadMedia: vi.fn() }));

const CTX: ActivityContext = { userId: 1, token: "tok", attemptId: 9, examName: "Algorithms" };
const PHOTO = "data:image/jpeg;base64,PHOTO";

beforeEach(() => {
  vi.mocked(activityLog).mockResolvedValue(undefined);
  vi.mocked(reportCheating).mockResolvedValue(undefined as never);
  vi.mocked(uploadMedia).mockResolvedValue(undefined as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// everything here is fire-and-forget by design (logActivity itself is synchronous) - flush the
// microtask queue so the promises it kicked off get a chance to settle before assertions run
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("logActivity", () => {
  it("always writes the local activity log", async () => {
    logActivity(CTX, "question_opened", "Opened question 1");
    await flush();

    expect(activityLog).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 1, attempt_id: 9, exam_name: "Algorithms", kind: "question_opened", detail: "Opened question 1" }),
    );
    expect(reportCheating).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("reports a cheating-kind event to the server too", async () => {
    logActivity(CTX, "phone_seen", "A phone is in view of the camera", { data: { image: PHOTO } });
    await flush();

    expect(reportCheating).toHaveBeenCalledWith("tok", 9, "phone_seen", "A phone is in view of the camera");
  });

  it("does not report a non-cheating kind as cheating", async () => {
    logActivity(CTX, "window_returned", "Back in the exam window");
    await flush();

    expect(reportCheating).not.toHaveBeenCalled();
  });

  it("uploads the snapshot for a photo kind that has an image", async () => {
    logActivity(CTX, "phone_seen", "A phone is in view of the camera", { data: { image: PHOTO } });
    await flush();

    expect(uploadMedia).toHaveBeenCalledWith("tok", 9, "snapshots", PHOTO, "A phone is in view of the camera");
  });

  it("uploads nothing for a photo kind whose budget ran out (no image in the data)", async () => {
    logActivity(CTX, "phone_seen", "A phone is in view of the camera", { data: {} });
    await flush();

    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("never uploads for a kind that isn't a photo kind, even if data happens to carry an image", async () => {
    logActivity(CTX, "devtools_attempt", "Tried to open devtools", { data: { image: PHOTO } });
    await flush();

    expect(reportCheating).toHaveBeenCalled(); // it is still a cheating kind
    expect(uploadMedia).not.toHaveBeenCalled(); // but not a photo kind
  });

  it("retries a failed sync once, silently, instead of losing it", async () => {
    vi.mocked(uploadMedia).mockRejectedValueOnce(new Error("network blip")).mockResolvedValueOnce(undefined as never);

    logActivity(CTX, "phone_seen", "A phone is in view of the camera", { data: { image: PHOTO } });
    await flush();
    await flush();

    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("retrying once"), expect.any(Error));
  });

  it("logs, but does not throw, when a sync fails twice in a row", async () => {
    vi.mocked(reportCheating).mockRejectedValue(new Error("server down"));

    expect(() => logActivity(CTX, "phone_seen", "A phone is in view of the camera")).not.toThrow();
    await flush();
    await flush();

    expect(reportCheating).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("giving up"), expect.any(Error));
  });
});
