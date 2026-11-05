// The microphone during an exam. Its volume level, read live, feeds two things: whether there's
// voice activity while a second face is in view (see cameraWatch's "talking" check, never
// recorded), and - independently of the camera - whether sound from outside the exam has been
// going on long enough to be worth a clip for staff to listen to themselves.

import { useEffect, useRef, useState } from "react";

export type MicEventKind = "mic_on" | "mic_off" | "mic_failed" | "background_noise";

/** How loud the waveform's deviation from silence needs to be (0-128 scale) to count as someone
 * speaking rather than room/fan noise - a rough, uncalibrated cutoff, which is why the judge in
 * cameraWatch.ts also requires several ticks of this in a row before it means anything, and the
 * noise watch below requires many more. */
const VOICE_THRESHOLD = 25;

// Sampled on its own timer rather than piggybacking on cameraWatch's tick, so this keeps running
// even with the camera off or between its looks.
const NOISE_TICK_MS = 500;
/** Ticks of sound in a row (at NOISE_TICK_MS) before it counts as "constant" rather than a
 * cough, a door, or a word or two - about 5 seconds. */
const NOISE_TICKS = 10;
/** How long a clip to record once that holds, in ms. Not a rolling buffer: recording only starts
 * once the threshold is crossed, so the lead-in before that moment isn't in the clip. */
const CLIP_MS = 5_000;
/** Minimum gap between clips while the noise just keeps going, so one noisy stretch sends one
 * clip rather than one every time the ticks roll over. */
const CLIP_COOLDOWN_MS = 30_000;

const rms = (data: Uint8Array): number => {
  let sumSquares = 0;
  for (const value of data) {
    const deviation = value - 128;
    sumSquares += deviation * deviation;
  }
  return Math.sqrt(sumSquares / data.length);
};

// btoa needs a plain string, and spreading a whole clip's bytes into String.fromCharCode at once
// risks a call-stack overflow - built up a chunk at a time instead.
const BASE64_CHUNK = 0x8000;
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
};

export function useMicrophone(onEvent: (kind: MicEventKind, detail: string, data?: Record<string, unknown>) => void) {
  const report = useRef(onEvent);
  report.current = onEvent;
  const [problem, setProblem] = useState<string | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const buffer = useRef<Uint8Array | null>(null);

  // the level check both isSpeaking() and the noise watch below need, read fresh each time
  const level = (): number => {
    const node = analyser.current;
    const data = buffer.current;
    if (!node || !data) return 0;
    // TS's dom lib types this as Uint8Array<ArrayBuffer> specifically; `data` always is one
    // (constructed with a plain length, never over a SharedArrayBuffer), just not inferred as such
    node.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
    return rms(data);
  };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let acquired = false;
    let noiseTimer: ReturnType<typeof setInterval> | undefined;
    let noisyTicks = 0;
    let recording = false;
    let lastClipAt = 0;

    const failed = (reason: string) => {
      setProblem(reason);
      report.current("mic_failed", `The microphone isn't available: ${reason}`);
    };

    // One clip, from right now - not a reason to hold up the exam if MediaRecorder has nothing
    // for this stream, so a failure here is swallowed, same as a broken camera check would be.
    const recordClip = () => {
      if (!stream || recording || typeof MediaRecorder === "undefined") return;
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        return;
      }
      recording = true;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        recording = false;
        if (!chunks.length) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        void blob.arrayBuffer().then((buf) => {
          const audio = `data:${blob.type};base64,${toBase64(new Uint8Array(buf))}`;
          report.current("background_noise", "Constant sound picked up from outside the exam", { audio });
        });
      };
      recorder.start();
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, CLIP_MS);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return failed("this computer can't give the app a microphone");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        return failed(err instanceof DOMException ? err.name : String(err));
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());

      context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const node = context.createAnalyser();
      node.fftSize = 512;
      source.connect(node);
      analyser.current = node;
      buffer.current = new Uint8Array(node.frequencyBinCount);
      acquired = true;
      report.current("mic_on", "Microphone on");

      noiseTimer = setInterval(() => {
        if (level() > VOICE_THRESHOLD) {
          noisyTicks += 1;
          if (noisyTicks >= NOISE_TICKS && Date.now() - lastClipAt >= CLIP_COOLDOWN_MS) {
            lastClipAt = Date.now();
            recordClip();
          }
        } else {
          noisyTicks = 0;
        }
      }, NOISE_TICK_MS);
    })();

    return () => {
      stopped = true;
      analyser.current = null;
      buffer.current = null;
      clearInterval(noiseTimer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
      if (acquired) report.current("mic_off", "Microphone off");
    };
  }, []);

  /** Whether there's voice-level sound right now; false until the microphone is ready or if it
   * never became available - never a reason to hold up the exam. */
  const isSpeaking = (): boolean => level() > VOICE_THRESHOLD;

  return { problem, isSpeaking };
}
