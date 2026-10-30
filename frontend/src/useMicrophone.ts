// The microphone during an exam - used only to tell whether there's voice activity while a
// second face is in view (see cameraWatch's "talking" check). Never recorded, transcribed or
// sent anywhere; each tick just reads a live volume level and throws it away.

import { useEffect, useRef, useState } from "react";

export type MicEventKind = "mic_on" | "mic_off" | "mic_failed";

/** How loud the waveform's deviation from silence needs to be (0-128 scale) to count as someone
 * speaking rather than room/fan noise - a rough, uncalibrated cutoff, which is why the judge in
 * cameraWatch.ts also requires several ticks of this in a row before it means anything. */
const VOICE_THRESHOLD = 25;

export function useMicrophone(onEvent: (kind: MicEventKind, detail: string) => void) {
  const report = useRef(onEvent);
  report.current = onEvent;
  const [problem, setProblem] = useState<string | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const buffer = useRef<Uint8Array | null>(null);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let acquired = false;

    const failed = (reason: string) => {
      setProblem(reason);
      report.current("mic_failed", `The microphone isn't available: ${reason}`);
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
    })();

    return () => {
      stopped = true;
      analyser.current = null;
      buffer.current = null;
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
      if (acquired) report.current("mic_off", "Microphone off");
    };
  }, []);

  /** Whether there's voice-level sound right now; false until the microphone is ready or if it
   * never became available - never a reason to hold up the exam. */
  const isSpeaking = (): boolean => {
    const node = analyser.current;
    const data = buffer.current;
    if (!node || !data) return false;
    // TS's dom lib types this as Uint8Array<ArrayBuffer> specifically; `data` always is one
    // (constructed with a plain length, never over a SharedArrayBuffer), just not inferred as such
    node.getByteTimeDomainData(data as Uint8Array<ArrayBuffer>);
    let sumSquares = 0;
    for (const value of data) {
      const deviation = value - 128;
      sumSquares += deviation * deviation;
    }
    return Math.sqrt(sumSquares / data.length) > VOICE_THRESHOLD;
  };

  return { problem, isSpeaking };
}
