import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMicrophone } from "./useMicrophone";

const NOISE_TICK_MS = 500;
const NOISE_TICKS = 10;
const CLIP_COOLDOWN_MS = 30_000;

// driven by the test: every getByteTimeDomainData call fills the buffer from this level, where
// 0 is silence and 40 is comfortably over VOICE_THRESHOLD (25)
let level = 0;

class FakeAnalyser {
  fftSize = 512;
  frequencyBinCount = 256;
  getByteTimeDomainData(data: Uint8Array) {
    data.fill(128 + level);
  }
}

class FakeAudioContext {
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  close() {
    return Promise.resolve();
  }
}

// captured so a test can drive start/stop and inspect what it was constructed with
let recorders: FakeMediaRecorder[];
class FakeMediaRecorder {
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    recorders.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["clip"], { type: this.mimeType }) });
    this.onstop?.();
  }
}

// jsdom's own Blob has no arrayBuffer() (real browsers do) - stand in with one that does, same
// idea as the AudioContext/MediaRecorder stubs above.
class FakeBlob {
  type: string;
  size: number;
  private parts: BlobPart[];
  constructor(parts: BlobPart[] = [], opts?: { type?: string }) {
    this.parts = parts;
    this.type = opts?.type ?? "";
    this.size = parts.reduce((n, part) => n + String(part).length, 0);
  }
  arrayBuffer() {
    const text = this.parts.join("");
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return Promise.resolve(bytes.buffer);
  }
}

function fakeStream() {
  const track = { stop: vi.fn() };
  return { getTracks: () => [track] } as unknown as MediaStream;
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  level = 0;
  recorders = [];
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("Blob", FakeBlob);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn().mockResolvedValue(fakeStream()) },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMicrophone", () => {
  it("reports mic_on once the stream and analyser are ready", async () => {
    const onEvent = vi.fn();
    renderHook(() => useMicrophone(onEvent));
    await advance(0);

    expect(onEvent).toHaveBeenCalledWith("mic_on", "Microphone on");
  });

  it("reports mic_failed when there is no getUserMedia at all", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const onEvent = vi.fn();
    renderHook(() => useMicrophone(onEvent));
    await advance(0);

    expect(onEvent).toHaveBeenCalledWith("mic_failed", expect.stringContaining("isn't available"));
  });

  it("isSpeaking reflects the live level once the microphone is ready", async () => {
    const { result } = renderHook(() => useMicrophone(vi.fn()));
    await advance(0);

    expect(result.current.isSpeaking()).toBe(false);
    level = 40;
    expect(result.current.isSpeaking()).toBe(true);
  });

  it("records and uploads a clip after sound holds for the full sustained window", async () => {
    const onEvent = vi.fn();
    renderHook(() => useMicrophone(onEvent));
    await advance(0);

    level = 40;
    await advance(NOISE_TICK_MS * (NOISE_TICKS - 1));
    expect(recorders).toHaveLength(0); // not yet - one tick short of the threshold

    await advance(NOISE_TICK_MS);
    expect(recorders).toHaveLength(1);
    expect(recorders[0]?.state).toBe("recording");

    await advance(5_000); // CLIP_MS: the hook's own timer stops the recorder
    await advance(0); // let the stop handler's blob.arrayBuffer() promise settle
    expect(onEvent).toHaveBeenCalledWith(
      "background_noise",
      "Constant sound picked up from outside the exam",
      { audio: expect.stringMatching(/^data:audio\/webm;base64,/) },
    );
  });

  it("never records while the noise is only intermittent", async () => {
    renderHook(() => useMicrophone(vi.fn()));
    await advance(0);

    for (let i = 0; i < NOISE_TICKS * 2; i++) {
      level = i % 2 === 0 ? 40 : 0; // alternates, so the streak keeps resetting
      await advance(NOISE_TICK_MS);
    }

    expect(recorders).toHaveLength(0);
  });

  it("does not start a second clip until the cooldown has passed", async () => {
    renderHook(() => useMicrophone(vi.fn()));
    await advance(0);

    level = 40;
    await advance(NOISE_TICK_MS * NOISE_TICKS); // the first clip starts here - this is lastClipAt
    expect(recorders).toHaveLength(1);

    await advance(CLIP_COOLDOWN_MS - NOISE_TICK_MS); // one tick short of the cooldown elapsing
    expect(recorders).toHaveLength(1);

    await advance(NOISE_TICK_MS); // the cooldown has now fully elapsed
    expect(recorders).toHaveLength(2);
  });

  it("stops the stream and reports mic_off on unmount", async () => {
    const onEvent = vi.fn();
    const { unmount } = renderHook(() => useMicrophone(onEvent));
    await advance(0);

    unmount();

    expect(onEvent).toHaveBeenCalledWith("mic_off", "Microphone off");
  });
});
