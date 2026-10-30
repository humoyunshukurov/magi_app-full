// Watches the camera picture while an exam is open and reports a phone in view, nobody in front
// of the camera, or a second face in it, with a photo taken at that moment.

import { useEffect, useRef } from "react";
import { createJudge, loadDetector } from "./cameraWatch";

export type WatchEventKind = "phone_seen" | "camera_away" | "camera_back" | "camera_checks_off" | "extra_person" | "talking" | "looking_away";
type Picture = HTMLVideoElement | HTMLImageElement;

// Halved from 1000ms: a person walking past in the background, or stepping up beside the
// student, can cross the frame in well under a second - sampling twice as often catches far more
// of those than the face model's own miss rate alone would explain.
export const TICK_MS = 500;
// Looking for a phone is the slow part, so it happens less often than every look - kept at the
// same real-world cadence as before (every 2s) despite the faster tick, by doubling the stride.
const PHONE_EVERY = 4;
/** Photos are kept on this computer, so there is a cap per exam - per event kind, so a run of
 * camera_away/extra_person events (an easily-flaked face read) can't use up the budget a genuine
 * phone_seen later in the exam would otherwise get. */
export const PHOTO_LIMIT = 20;
const MAX_SIDE = 640;

function sizeOf(picture: Picture) {
  if (picture instanceof HTMLVideoElement) return picture.readyState >= 2 ? { w: picture.videoWidth, h: picture.videoHeight } : null;
  return picture.complete ? { w: picture.naturalWidth, h: picture.naturalHeight } : null;
}

export function useCameraWatch(
  picture: () => Picture | null,
  running: boolean,
  onEvent: (kind: WatchEventKind, detail: string, data: Record<string, unknown>) => void,
  /** Omitted (or returning false) when there's no microphone - "talking" just never fires. */
  isSpeaking?: () => boolean,
) {
  const pictureRef = useRef(picture);
  pictureRef.current = picture;
  const report = useRef(onEvent);
  report.current = onEvent;
  const speaking = useRef(isSpeaking);
  speaking.current = isSpeaking;

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detector: Awaited<ReturnType<typeof loadDetector>> | null = null;
    const canvas = document.createElement("canvas");
    const judge = createJudge();
    let looks = 0;
    const photosByKind: Partial<Record<WatchEventKind, number>> = {};
    // a single bad frame (canvas not ready yet, a transient model hiccup) must not end watching
    // for the rest of the exam - note it once, but keep ticking either way
    let reportedBrokenCheck = false;

    const tick = () => {
      const source = pictureRef.current();
      const size = source && sizeOf(source);
      if (source && size && size.w > 0 && detector) {
        const scale = Math.min(1, MAX_SIDE / Math.max(size.w, size.h));
        canvas.width = Math.round(size.w * scale);
        canvas.height = Math.round(size.h * scale);
        try {
          canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
          const videoLook = detector.look(canvas, { phone: looks % PHONE_EVERY === 0 });
          const look = { ...videoLook, voice: speaking.current ? speaking.current() : null };
          looks += 1;
          for (const verdict of judge.feed(look, Date.now())) {
            if (verdict.kind === "camera_back") {
              report.current(verdict.kind, verdict.detail, { away_seconds: verdict.awaySeconds });
            } else {
              // the photo is the frame that was just looked at - budget tracked per event kind
              const taken = photosByKind[verdict.kind] ?? 0;
              const image = taken < PHOTO_LIMIT ? canvas.toDataURL("image/jpeg", 0.7) : null;
              if (image) photosByKind[verdict.kind] = taken + 1;
              report.current(verdict.kind, verdict.detail, image ? { image } : {});
            }
          }
        } catch (err) {
          if (!reportedBrokenCheck) {
            reportedBrokenCheck = true;
            report.current("camera_checks_off", `Phone and presence checks stopped: ${String(err)}`, {});
          }
        }
      }
      timer = setTimeout(tick, TICK_MS);
    };

    loadDetector().then(
      (loaded) => {
        if (cancelled) return loaded.close();
        detector = loaded;
        tick();
      },
      (err) => {
        if (!cancelled) report.current("camera_checks_off", `Phone and presence checks can't run: ${String(err)}`, {});
      },
    );

    return () => {
      cancelled = true;
      clearTimeout(timer);
      detector?.close();
    };
  }, [running]);
}
