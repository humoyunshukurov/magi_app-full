// mic level: talking (for cameraWatch, never recorded) and background noise clips

import { useEffect, useRef, useState } from "react";

export type MicEventKind = "mic_on" | "mic_off" | "mic_failed" | "background_noise";

/** 0-128, normal speech at a laptop mic is roughly 4-15 */
const VOICE_THRESHOLD = 10;
/** lower than voice, noise from another room is quieter */
const NOISE_THRESHOLD = 5;

// own timer so it works with the camera off
const NOISE_TICK_MS = 500;
/** How much recent history the noise watch looks back over, in ticks - 8 seconds. */
const NOISE_WINDOW_TICKS = 16;
/** 60% of the window, real noise has gaps */
const NOISE_REQUIRED_RATIO = 0.6;
/** ms, starts after the threshold is hit */
const CLIP_MS = 5_000;
/** one clip per noisy stretch */
const CLIP_COOLDOWN_MS = 30_000;

const rms = (data: Uint8Array): number => {
  let sumSquares = 0;
  for (const value of data) {
    const deviation = value - 128;
    sumSquares += deviation * deviation;
  }
  return Math.sqrt(sumSquares / data.length);
};

// in chunks, spreading the whole thing can overflow the stack
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
    // it's always a plain ArrayBuffer here
    node.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
    return rms(data);
  };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let acquired = false;
    let noiseTimer: ReturnType<typeof setInterval> | undefined;
    const noiseHistory: boolean[] = [];
    let recording = false;
    let lastClipAt = 0;

    const failed = (reason: string) => {
      setProblem(reason);
      report.current("mic_failed", `The microphone isn't available: ${reason}`);
    };

    const NOISE_DETAIL = "Constant sound picked up from outside the exam";

    // best-effort, without a recorder it's still reported, just with no clip
    const recordClip = () => {
      if (!stream || recording) return;
      if (typeof MediaRecorder === "undefined") return report.current("background_noise", NOISE_DETAIL);
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        return report.current("background_noise", NOISE_DETAIL);
      }
      recording = true;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onstop = () => {
        recording = false;
        if (!chunks.length) return report.current("background_noise", NOISE_DETAIL);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        void blob.arrayBuffer().then((buf) => {
          const audio = `data:${blob.type};base64,${toBase64(new Uint8Array(buf))}`;
          report.current("background_noise", NOISE_DETAIL, { audio });
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
        noiseHistory.push(level() > NOISE_THRESHOLD);
        if (noiseHistory.length > NOISE_WINDOW_TICKS) noiseHistory.shift();

        if (noiseHistory.length < NOISE_WINDOW_TICKS) return; // not enough history yet to judge
        const loudRatio = noiseHistory.filter(Boolean).length / noiseHistory.length;
        if (loudRatio >= NOISE_REQUIRED_RATIO && Date.now() - lastClipAt >= CLIP_COOLDOWN_MS) {
          lastClipAt = Date.now();
          recordClip();
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

  /** false until the mic is ready */
  const isSpeaking = (): boolean => level() > VOICE_THRESHOLD;

  return { problem, isSpeaking };
}
