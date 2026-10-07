// Watches the camera picture while an exam is open and reports a phone in view, or nobody
// in front of the camera, with a photo taken at that moment.

import { useEffect, useRef } from "react";
import { createJudge, loadDetector } from "./cameraWatch";

export type WatchEventKind = "phone_seen" | "camera_away" | "camera_back" | "camera_checks_off";
type Picture = HTMLVideoElement | HTMLImageElement;

export const TICK_MS = 1000;
/** Looking for a phone is the slow part, so it happens on every other look. */
const PHONE_EVERY = 2;
/** Photos are kept on this computer, so there is a cap per exam. */
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
) {
  const pictureRef = useRef(picture);
  pictureRef.current = picture;
  const report = useRef(onEvent);
  report.current = onEvent;

  useEffect(() => {
    if (!running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let detector: Awaited<ReturnType<typeof loadDetector>> | null = null;
    const canvas = document.createElement("canvas");
    const judge = createJudge();
    let looks = 0;
    let photos = 0;

    const tick = () => {
      const source = pictureRef.current();
      const size = source && sizeOf(source);
      if (source && size && size.w > 0 && detector) {
        const scale = Math.min(1, MAX_SIDE / Math.max(size.w, size.h));
        canvas.width = Math.round(size.w * scale);
        canvas.height = Math.round(size.h * scale);
        try {
          canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
          const look = detector.look(canvas, { phone: looks % PHONE_EVERY === 0 });
          looks += 1;
          for (const verdict of judge.feed(look, Date.now())) {
            if (verdict.kind === "camera_back") {
              report.current(verdict.kind, verdict.detail, { away_seconds: verdict.awaySeconds });
            } else {
              // the photo is the frame that was just looked at
              const image = photos < PHOTO_LIMIT ? canvas.toDataURL("image/jpeg", 0.7) : null;
              if (image) photos += 1;
              report.current(verdict.kind, verdict.detail, image ? { image } : {});
            }
          }
        } catch (err) {
          report.current("camera_checks_off", `Phone and presence checks stopped: ${String(err)}`, {});
          return;
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
