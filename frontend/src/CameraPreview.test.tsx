import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraPreview } from "./CameraPreview";
import { cameraStart, cameraStop, onCameraFrame, onCameraLost } from "./ipc";

vi.mock("./cameraWatch", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cameraWatch")>()), loadDetector: () => new Promise(() => {}) }));
vi.mock("./ipc", () => ({ cameraStart: vi.fn(), cameraStop: vi.fn(), onCameraFrame: vi.fn(), onCameraLost: vi.fn() }));

function stubCamera(getUserMedia?: () => Promise<unknown>) {
  Object.defineProperty(navigator, "mediaDevices", { value: getUserMedia ? { getUserMedia } : undefined, configurable: true });
}

function fakeStream() {
  const track = { label: "Integrated Camera", stop: vi.fn(), addEventListener: vi.fn() };
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } };
}

const unlisten = { frame: vi.fn(), lost: vi.fn() };
let sendFrame: (jpeg: string) => void;
let loseCamera: (reason: string) => void;

beforeEach(() => {
  vi.mocked(cameraStart).mockResolvedValue(null);
  vi.mocked(cameraStop).mockResolvedValue(undefined);
  vi.mocked(onCameraFrame).mockImplementation((handler) => {
    sendFrame = handler;
    return Promise.resolve(unlisten.frame);
  });
  vi.mocked(onCameraLost).mockImplementation((handler) => {
    loseCamera = handler;
    return Promise.resolve(unlisten.lost);
  });
});

afterEach(() => {
  cleanup();
  stubCamera();
  vi.clearAllMocks();
});

describe("CameraPreview, camera opened by the webview", () => {
  it("turns the camera on, shows it, and switches it off when the exam ends", async () => {
    const { track, stream } = fakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    stubCamera(getUserMedia);
    const onEvent = vi.fn();

    const { unmount } = render(<CameraPreview onEvent={onEvent} />);
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("camera_on", "Camera on: Integrated Camera"));
    expect(getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(screen.getByText("Camera on")).toBeTruthy();
    expect((screen.getByLabelText("Your camera") as HTMLVideoElement & { srcObject: unknown }).srcObject).toBe(stream);

    unmount();
    expect(track.stop).toHaveBeenCalled();
    expect(onEvent).toHaveBeenLastCalledWith("camera_off", "Camera off");
  });

  it("says so and records it when the camera is refused", async () => {
    stubCamera(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const onEvent = vi.fn();

    render(<CameraPreview onEvent={onEvent} />);
    await screen.findByRole("alert");

    expect(screen.getByRole("alert").textContent).toContain("NotAllowedError");
    expect(onEvent).toHaveBeenCalledWith("camera_failed", "The camera isn't available: NotAllowedError");
  });

  it("copes with a webview that has no camera support at all", async () => {
    stubCamera();
    const onEvent = vi.fn();

    render(<CameraPreview onEvent={onEvent} />);
    await screen.findByRole("alert");

    expect(onEvent).toHaveBeenCalledWith("camera_failed", expect.stringContaining("can't give the app a camera"));
  });

  it("lets go of a camera that arrived after the exam was already closed", async () => {
    const { track, stream } = fakeStream();
    let arrive!: (s: unknown) => void;
    const getUserMedia = vi.fn(() => new Promise((resolve) => (arrive = resolve)));
    stubCamera(getUserMedia);
    const onEvent = vi.fn();

    const { unmount } = render(<CameraPreview onEvent={onEvent} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    unmount();
    arrive(stream);

    await waitFor(() => expect(track.stop).toHaveBeenCalled());
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("never opens the camera when the exam closed while the app was still starting", async () => {
    const getUserMedia = vi.fn();
    stubCamera(getUserMedia);

    render(<CameraPreview onEvent={vi.fn()} />).unmount();
    await waitFor(() => expect(cameraStart).toHaveBeenCalled());
    await Promise.resolve();

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe("CameraPreview, camera read by the app", () => {
  const getUserMedia = vi.fn();

  beforeEach(() => {
    vi.mocked(cameraStart).mockResolvedValue("HP TrueVision HD Camera");
    stubCamera(getUserMedia);
  });

  it("shows the frames the app sends, without asking the webview for the camera", async () => {
    const onEvent = vi.fn();
    render(<CameraPreview onEvent={onEvent} />);
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("camera_on", "Camera on: HP TrueVision HD Camera"));

    sendFrame("QUJD");
    expect((screen.getByAltText("Your camera") as HTMLImageElement).src).toBe("data:image/jpeg;base64,QUJD");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops the camera and the frame feed when the exam ends", async () => {
    const onEvent = vi.fn();
    const { unmount } = render(<CameraPreview onEvent={onEvent} />);
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("camera_on", expect.anything()));

    unmount();
    expect(cameraStop).toHaveBeenCalled();
    expect(unlisten.frame).toHaveBeenCalled();
    expect(unlisten.lost).toHaveBeenCalled();
    expect(onEvent).toHaveBeenLastCalledWith("camera_off", "Camera off");
  });

  it("says so and records it when the camera can't be started", async () => {
    vi.mocked(cameraStart).mockRejectedValue("no camera found");
    const onEvent = vi.fn();

    render(<CameraPreview onEvent={onEvent} />);
    await screen.findByRole("alert");

    expect(screen.getByRole("alert").textContent).toContain("no camera found");
    expect(onEvent).toHaveBeenCalledWith("camera_failed", "The camera isn't available: no camera found");
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("stops a camera the app started after the exam was already closed", async () => {
    let started!: (name: string) => void;
    vi.mocked(cameraStart).mockReturnValue(new Promise((resolve) => (started = resolve)));
    const onEvent = vi.fn();

    render(<CameraPreview onEvent={onEvent} />).unmount();
    started("HP TrueVision HD Camera");

    await waitFor(() => expect(cameraStop).toHaveBeenCalled());
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("says so when the camera stops delivering during the exam", async () => {
    const onEvent = vi.fn();
    render(<CameraPreview onEvent={onEvent} />);
    await waitFor(() => expect(onEvent).toHaveBeenCalledWith("camera_on", expect.anything()));

    loseCamera("No such device");
    await screen.findByRole("alert");
    expect(onEvent).toHaveBeenCalledWith("camera_failed", "The camera isn't available: No such device");
  });
});
