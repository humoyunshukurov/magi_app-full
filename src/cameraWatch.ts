// Looks at the camera picture for what matters during an exam: a phone in view, nobody in front
// of the camera, and more than one face in it. Everything runs on this computer (MediaPipe, from
// the app's own files); no picture leaves it.

/** What one look at the camera picture found. */
export interface Look {
  faces: number;
  /** null when this look didn't check for a phone */
  phone: boolean | null;
}

export interface Detector {
  /** Finding a phone is the costly part, so it only runs when asked for. */
  look(picture: HTMLCanvasElement, options: { phone: boolean }): Look;
  close(): void;
}

const BASE = "/mediapipe";

export async function loadDetector(): Promise<Detector> {
  // loaded on demand: the library is big and only an exam with a camera needs it
  const { FaceDetector, FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
  const vision = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  const face = await FaceDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${BASE}/models/blaze_face_short_range.tflite`, delegate: "CPU" },
    canvas: document.createElement("canvas"),
    runningMode: "IMAGE",
    minDetectionConfidence: 0.5,
  });
  const objects = await ObjectDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${BASE}/models/efficientdet_lite0.tflite`, delegate: "CPU" },
    canvas: document.createElement("canvas"),
    runningMode: "IMAGE",
    categoryAllowlist: ["cell phone"],
    scoreThreshold: 0.35,
    maxResults: 1,
  });
  return {
    look: (picture, { phone }) => ({
      faces: face.detect(picture).detections.length,
      phone: phone ? objects.detect(picture).detections.length > 0 : null,
    }),
    close: () => {
      face.close();
      objects.close();
    },
  };
}

export type Verdict =
  | { kind: "camera_away"; detail: string }
  | { kind: "camera_back"; detail: string; awaySeconds: number }
  | { kind: "phone_seen"; detail: string }
  | { kind: "extra_person"; detail: string };

/** How long nobody may be in front of the camera before it counts as leaving. */
export const AWAY_MS = 3000;
/** Looks in a row that must show a phone, so one wrong guess doesn't count. */
const PHONE_LOOKS = 2;
/** Looks in a row without a phone before a phone can be reported again. */
const PHONE_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon. */
const PHONE_COOLDOWN_MS = 10_000;
/** A second face is reported the moment it's seen - even a quick walk-by matters here. */
const EXTRA_PERSON_LOOKS = 1;
/** Looks in a row back down to one face before an extra person can be reported again. */
const EXTRA_PERSON_GONE_LOOKS = 2;

/** Turns a stream of looks into the few things worth writing down. */
export function createJudge() {
  let missingSince: number | null = null;
  let away = false;
  let phoneLooks = 0;
  let phoneReported = false;
  let clearLooks = PHONE_GONE_LOOKS;
  let lastPhoneAt = -Infinity;
  let extraPersonLooks = 0;
  let extraPersonReported = false;
  let extraPersonClearLooks = EXTRA_PERSON_GONE_LOOKS;

  return {
    feed(look: Look, now: number): Verdict[] {
      const verdicts: Verdict[] = [];

      if (look.faces === 0) {
        missingSince ??= now;
        if (!away && now - missingSince >= AWAY_MS) {
          away = true;
          verdicts.push({ kind: "camera_away", detail: "Nobody in front of the camera" });
        }
      } else {
        if (away && missingSince !== null) {
          const awaySeconds = Math.round((now - missingSince) / 1000);
          verdicts.push({ kind: "camera_back", detail: `Back in front of the camera after ${awaySeconds} s`, awaySeconds });
        }
        missingSince = null;
        away = false;
      }

      if (look.faces > 1) {
        extraPersonLooks += 1;
        extraPersonClearLooks = 0;
        if (extraPersonLooks >= EXTRA_PERSON_LOOKS && !extraPersonReported) {
          extraPersonReported = true;
          verdicts.push({ kind: "extra_person", detail: `${look.faces} faces in view of the camera` });
        }
      } else {
        extraPersonLooks = 0;
        extraPersonClearLooks += 1;
        if (extraPersonClearLooks >= EXTRA_PERSON_GONE_LOOKS) extraPersonReported = false;
      }

      if (look.phone === null) {
        return verdicts;
      }
      if (look.phone) {
        phoneLooks += 1;
        clearLooks = 0;
        if (phoneLooks >= PHONE_LOOKS && !phoneReported && now - lastPhoneAt >= PHONE_COOLDOWN_MS) {
          phoneReported = true;
          lastPhoneAt = now;
          verdicts.push({ kind: "phone_seen", detail: "A phone is in view of the camera" });
        }
      } else {
        phoneLooks = 0;
        clearLooks += 1;
        if (clearLooks >= PHONE_GONE_LOOKS) phoneReported = false;
      }

      return verdicts;
    },
  };
}
