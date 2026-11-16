import { useEffect, useRef } from "react";
import { createJudge, loadDetector } from "./cameraWatch";

export type WatchEventKind = "phone_seen" | "camera_away" | "camera_back" | "camera_checks_off" | "extra_person" | "talking" | "looking_away";
type Picture = HTMLVideoElement | HTMLImageElement;

// 500ms, someone walking past can cross the frame in under a second
export const TICK_MS = 500;
// phone check still every 2s
const PHONE_EVERY = 4;
/** per kind, so camera_away noise can't use up phone_seen's photos */
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
    // one bad frame shouldn't stop watching
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
