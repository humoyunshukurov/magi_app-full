import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDetector, type Look } from "./cameraWatch";
import { TICK_MS, useCameraWatch } from "./useCameraWatch";

vi.mock("./cameraWatch", async (importOriginal) => ({ ...(await importOriginal<typeof import("./cameraWatch")>()), loadDetector: vi.fn() }));

const PHOTO = "data:image/jpeg;base64,PHOTO";

function fakePicture() {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 4 });
  Object.defineProperty(video, "videoWidth", { value: 1280 });
  Object.defineProperty(video, "videoHeight", { value: 720 });
  return video;
}

let looks: Look[];
const detector = { look: vi.fn(), close: vi.fn() };
const onEvent = vi.fn();
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function watch(running = true) {
  const picture = fakePicture();
  return renderHook(({ on }) => useCameraWatch(() => picture, on, onEvent), { initialProps: { on: running } });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(PHOTO);
  looks = [];
  detector.look.mockImplementation(() => looks.shift() ?? { faces: 1, phone: false });
  vi.mocked(loadDetector).mockResolvedValue(detector);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useCameraWatch", () => {
  it("takes a photo and reports it when nobody has been in front of the camera for a few seconds", async () => {
    looks = [{ faces: 0, phone: false }, { faces: 0, phone: null }, { faces: 0, phone: false }, { faces: 0, phone: null }];
    watch();
    await advance(TICK_MS * 3); // the first look is right away, then one a second

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("camera_away", "Nobody in front of the camera", { image: PHOTO });
  });

  it("says how long it was when the student comes back", async () => {
    looks = [{ faces: 0, phone: false }, { faces: 0, phone: null }, { faces: 0, phone: false }, { faces: 0, phone: null }, { faces: 1, phone: false }];
    watch();
    await advance(TICK_MS * 6);

    expect(onEvent).toHaveBeenLastCalledWith("camera_back", expect.stringContaining("Back in front of the camera"), { away_seconds: expect.any(Number) });
  });

  it("takes a photo when a phone is in view on two looks in a row", async () => {
    looks = [{ faces: 1, phone: true }, { faces: 1, phone: null }, { faces: 1, phone: true }];
    watch();
    await advance(TICK_MS * 3);

    expect(onEvent).toHaveBeenCalledWith("phone_seen", "A phone is in view of the camera", { image: PHOTO });
  });

  it("takes a photo when a second face is seen", async () => {
    looks = [{ faces: 2, phone: false }];
    watch();
    await advance(TICK_MS);

    expect(onEvent).toHaveBeenCalledWith("extra_person", "2 faces in view of the camera", { image: PHOTO });
  });

  it("looks for a phone on every other look only, since that is the slow part", async () => {
    watch();
    await advance(TICK_MS * 4);

    expect(detector.look.mock.calls.map(([, options]) => options.phone)).toEqual([true, false, true, false, true]);
  });

  it("draws the picture at a size the detector can use", async () => {
    watch();
    await advance(TICK_MS);

    const canvas = detector.look.mock.calls[0]![0] as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([640, 360]);
  });

  it("says so when the checks can't start", async () => {
    vi.mocked(loadDetector).mockRejectedValue(new Error("no WebGL"));
    watch();
    await advance(TICK_MS);

    expect(onEvent).toHaveBeenCalledWith("camera_checks_off", expect.stringContaining("no WebGL"), {});
  });

  it("says so and stops when the detector breaks in the middle of the exam", async () => {
    detector.look.mockImplementation(() => {
      throw new Error("context lost");
    });
    watch();
    await advance(TICK_MS * 4);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("camera_checks_off", expect.stringContaining("context lost"), {});
  });

  it("does nothing until the camera is running, and lets the detector go when it stops", async () => {
    const { rerender, unmount } = watch(false);
    await advance(TICK_MS * 2);
    expect(loadDetector).not.toHaveBeenCalled();

    rerender({ on: true });
    await advance(TICK_MS);
    expect(detector.look).toHaveBeenCalled();

    unmount();
    expect(detector.close).toHaveBeenCalled();
    detector.look.mockClear();
    await advance(TICK_MS * 3);
    expect(detector.look).not.toHaveBeenCalled();
  });
});
