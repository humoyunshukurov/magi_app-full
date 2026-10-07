import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreExam, RECHECK_MS } from "./PreExam";
import { environmentCheck, screenshotTake } from "./ipc";
import { useCamera } from "./useCamera";

vi.mock("./ipc", () => ({ environmentCheck: vi.fn(), screenshotTake: vi.fn() }));
vi.mock("./useCamera", async () => {
  const { createElement } = await import("react");
  return { useCamera: vi.fn(), CameraPicture: () => createElement("div", { "aria-label": "Your camera" }) };
});

const calm = { monitor_count: 1, extra_screens_allowed: false, forbidden_apps: [], browsers: ["chrome"], other_windows: [], other_windows_allowed: false };
const grab = vi.fn();
let cameraEvent: Parameters<typeof useCamera>[0];

const camera = (over: Partial<ReturnType<typeof useCamera>> = {}) =>
  ({ source: "app", problem: null, grab, video: { current: null }, image: { current: null }, ...over }) as unknown as ReturnType<typeof useCamera>;

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function open(withPhotos = true) {
  const onReady = vi.fn();
  const onCancel = vi.fn();
  render(<PreExam examName="Writing Test" withPhotos={withPhotos} onReady={onReady} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  return { onReady, onCancel };
}

const typeId = (value: string) => fireEvent.change(screen.getByLabelText("ID number"), { target: { value } });
const startButton = () => screen.getByRole("button", { name: "Take the photo and start the exam" }) as HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(environmentCheck).mockResolvedValue(calm);
  vi.mocked(screenshotTake).mockResolvedValue("SCREEN");
  grab.mockReturnValue("data:image/jpeg;base64,PHOTO");
  vi.mocked(useCamera).mockImplementation((onEvent) => {
    cameraEvent = onEvent;
    return camera();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("PreExam, the warning", () => {
  it("shows the lock-and-leave warning first, before any check runs", () => {
    render(<PreExam examName="Writing Test" withPhotos onReady={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Before you start")).toBeTruthy();
    expect(environmentCheck).not.toHaveBeenCalled();
  });

  it("can be cancelled from the warning", () => {
    const onCancel = vi.fn();
    render(<PreExam examName="Writing Test" withPhotos onReady={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("moves on to the computer check once continued", async () => {
    open();
    await flush();
    expect(screen.queryByText("Before you start")).toBeNull();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
  });
});

describe("PreExam, the computer", () => {
  it("goes straight on to the ID and photo when the computer is fine", async () => {
    open();
    await flush();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops at a second screen and says what to do", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, monitor_count: 2 });
    open();
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("2 screens are connected. Disconnect all but one.");
    expect(screen.queryByText("Who is taking the exam")).toBeNull();
  });

  it("lets a second screen through on a developer's computer, but still stops at a forbidden app", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, monitor_count: 2, extra_screens_allowed: true });
    open();
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
    cleanup();

    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, monitor_count: 2, extra_screens_allowed: true, forbidden_apps: ["anydesk"] });
    open();
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("anydesk is running");
    expect(screen.getByRole("alert").textContent).not.toContain("screens are connected");
  });

  it("stops at a remote control or screen sharing app, not at a browser", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, forbidden_apps: ["anydesk"] });
    open();
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("anydesk is running. Close it.");
  });

  it("stops while other windows are still open, and says which", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, other_windows: ["Firefox", "Telegram"] });
    open();
    await flush();

    expect(screen.getByRole("alert").textContent).toContain("Other windows are open: Firefox, Telegram. Close them before starting.");
  });

  it("lets other windows through on a developer's computer, but still stops at a forbidden app", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, other_windows: ["code"], other_windows_allowed: true });
    open();
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
    cleanup();

    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, other_windows: ["code"], other_windows_allowed: true, forbidden_apps: ["anydesk"] });
    open();
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("anydesk is running");
    expect(screen.getByRole("alert").textContent).not.toContain("Other windows are open");
  });

  it("doesn't stop for other windows where they can't be checked (Linux)", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, other_windows: [] });
    open();
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
  });

  it("looks again by itself and goes on once the problem is gone", async () => {
    vi.mocked(environmentCheck).mockResolvedValueOnce({ ...calm, monitor_count: 2 }).mockResolvedValue(calm);
    open();
    await flush();
    expect(screen.getByRole("alert")).toBeTruthy();

    await advance(RECHECK_MS);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
  });

  it("can be cancelled while it is stopped", async () => {
    vi.mocked(environmentCheck).mockResolvedValue({ ...calm, monitor_count: 3 });
    const { onCancel } = open();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("goes on when the computer can't be read at all", async () => {
    vi.mocked(environmentCheck).mockRejectedValue(new Error("no app"));
    open();
    await flush();
    expect(screen.getByText("Who is taking the exam")).toBeTruthy();
  });

  it("only checks the computer when an exam that is already running is picked up again", async () => {
    const { onReady } = open(false);
    await flush();
    expect(onReady).toHaveBeenCalledWith({ idNumber: "", photo: null, notes: [] });
    expect(screen.queryByText("Who is taking the exam")).toBeNull();
  });
});

describe("PreExam, the ID number and photo", () => {
  async function ready() {
    const view = open();
    await flush();
    return view;
  }

  it("asks for the ID number and one photo, and hands both over", async () => {
    const { onReady } = await ready();
    typeId("  AB1234567 ");
    fireEvent.click(startButton());

    expect(grab).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ idNumber: "AB1234567", photo: "data:image/jpeg;base64,PHOTO", notes: [] });
  });

  it("won't go on without an ID number", async () => {
    await ready();
    expect(startButton().disabled).toBe(true);
    typeId("   ");
    expect(startButton().disabled).toBe(true);
    typeId("AB1");
    expect(startButton().disabled).toBe(false);
  });

  it("waits for the camera before it lets the photo be taken", async () => {
    vi.mocked(useCamera).mockImplementation(() => camera({ source: null }));
    open();
    await flush();
    typeId("AB1");

    expect((screen.getByRole("button", { name: "Starting camera…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks to try again when the camera has no picture yet", async () => {
    grab.mockReturnValueOnce(null);
    const { onReady } = await ready();
    typeId("AB1");

    fireEvent.click(startButton());
    expect(screen.getByText(/isn't ready yet/)).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();

    fireEvent.click(startButton());
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("waits for the screen to be tried before the exam can start, and says why", async () => {
    let allow!: (jpeg: string) => void;
    vi.mocked(screenshotTake).mockReturnValue(new Promise((resolve) => (allow = resolve)));
    await ready();
    typeId("AB1");

    expect(screen.getByRole("status").textContent).toContain("Checking your screen");
    expect(startButton().disabled).toBe(true);

    await act(async () => allow("LATE"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it("doesn't keep the picture of the screen, it was only a try", async () => {
    const { onReady } = await ready();
    typeId("AB1");
    fireEvent.click(startButton());

    expect(JSON.stringify(onReady.mock.calls[0]![0])).not.toContain("SCREEN");
  });

  it("lets the exam start when the screen can't be photographed, and notes it", async () => {
    vi.mocked(screenshotTake).mockRejectedValue("the screenshot wasn't allowed");
    const { onReady } = await ready();
    typeId("AB1");
    fireEvent.click(startButton());

    expect(onReady.mock.calls[0]![0].notes).toEqual([{ kind: "screenshot_failed", detail: "Couldn't take a screenshot: the screenshot wasn't allowed" }]);
  });

  it("lets the exam go on without a camera, with the ID number, and says so in the notes", async () => {
    vi.mocked(useCamera).mockImplementation((onEvent) => {
      cameraEvent = onEvent;
      return camera({ problem: "NotFoundError" });
    });
    const { onReady } = open();
    await flush();
    act(() => cameraEvent("camera_failed", "The camera isn't available: NotFoundError"));
    typeId("AB1");

    expect(screen.getByRole("alert").textContent).toContain("NotFoundError");
    fireEvent.click(screen.getByRole("button", { name: "Start without the photo" }));
    expect(onReady).toHaveBeenCalledWith({ idNumber: "AB1", photo: null, notes: [{ kind: "camera_failed", detail: "The camera isn't available: NotFoundError" }] });
  });

  it("can be cancelled", async () => {
    const { onCancel } = await ready();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
