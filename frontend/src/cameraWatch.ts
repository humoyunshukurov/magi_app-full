// phone, nobody there, extra person, talking. all runs locally (mediapipe + web audio)

/** What one look at the camera (and, for voice, the microphone) found. */
export interface Look {
  faces: number;
  /** null when this look didn't check for a phone */
  phone: boolean | null;
  /** null when there's no microphone to check */
  voice: boolean | null;
  /** null unless there's exactly one face */
  turned: boolean | null;
  /** person from the object model - catches someone whose face isn't visible. null when not checked */
  extraBody: boolean | null;
}

// right eye, left eye, nose, mouth, right ear, left ear
const RIGHT_EYE = 0;
const LEFT_EYE = 1;
const NOSE_TIP = 2;

/** eyes too close together to trust the estimate */
const MIN_EYE_SPAN = 0.02;
/** 0.5 = centered */
const TURN_LOW = 0.28;
const TURN_HIGH = 0.72;

/** rough yaw from the keypoints we already have */
export function headTurned(keypoints: { x: number; y: number }[]): boolean | null {
  const rightEye = keypoints[RIGHT_EYE];
  const leftEye = keypoints[LEFT_EYE];
  const nose = keypoints[NOSE_TIP];
  if (!rightEye || !leftEye || !nose) return null;
  const eyeSpan = leftEye.x - rightEye.x;
  if (Math.abs(eyeSpan) < MIN_EYE_SPAN) return null;
  const noseOffset = (nose.x - rightEye.x) / eyeSpan;
  return noseOffset < TURN_LOW || noseOffset > TURN_HIGH;
}

export interface Detector {
  /** slow, so only when asked */
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
  // same pass as the phone check
  const objects = await ObjectDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: `${BASE}/models/efficientdet_lite0.tflite`, delegate: "CPU" },
    canvas: document.createElement("canvas"),
    runningMode: "IMAGE",
    categoryAllowlist: ["cell phone", "person"],
    scoreThreshold: 0.35,
    maxResults: 5,
  });
  return {
    // voice isn't this detector's job (it has no microphone) - useCameraWatch fills it in
    look: (picture, { phone }) => {
      const detections = face.detect(picture).detections;
      const objectDetections = phone ? objects.detect(picture).detections : null;
      const category = (d: { categories: { categoryName?: string }[] }) => d.categories[0]?.categoryName;
      return {
        faces: detections.length,
        phone: objectDetections ? objectDetections.some((d) => category(d) === "cell phone") : null,
        voice: null,
        turned: detections.length === 1 ? headTurned(detections[0]!.keypoints) : null,
        // the primary student is a "person" too - this needs a second one to mean anything
        extraBody: objectDetections ? objectDetections.filter((d) => category(d) === "person").length >= 2 : null,
      };
    },
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
  | { kind: "extra_person"; detail: string }
  | { kind: "talking"; detail: string }
  | { kind: "looking_away"; detail: string };

/** How long nobody may be in front of the camera before it counts as leaving. */
export const AWAY_MS = 2000;
/** Phone-check results worth remembering at once, oldest first. */
const PHONE_WINDOW = 3;
/** hits out of the last PHONE_WINDOW, the model misses some frames */
const PHONE_LOOKS = 2;
/** Looks in a row without a phone before a phone can be reported again. */
const PHONE_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon. */
const PHONE_COOLDOWN_MS = 10_000;
/** two looks, a single frame gives false positives */
const EXTRA_PERSON_LOOKS = 2;
/** Looks in a row back down to one face before an extra person can be reported again. */
const EXTRA_PERSON_GONE_LOOKS = 2;
/** ~1.5s of second face + voice */
const TALKING_LOOKS = 3;
/** Looks in a row without that combination before talking can be reported again. */
const TALKING_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon - a single conversation shouldn't spam incidents. */
const TALKING_COOLDOWN_MS = 15_000;
/** a couple of seconds, not a glance */
const LOOKING_AWAY_LOOKS = 4;
/** Looks in a row facing forward again before this can be reported again. */
const LOOKING_AWAY_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon. */
const LOOKING_AWAY_COOLDOWN_MS = 15_000;

/** Turns a stream of looks into the few things worth writing down. */
export function createJudge() {
  let missingSince: number | null = null;
  let away = false;
  const phoneWindow: boolean[] = [];
  let phoneReported = false;
  let clearLooks = PHONE_GONE_LOOKS;
  let lastPhoneAt = -Infinity;
  let extraPersonLooks = 0;
  let extraPersonReported = false;
  let extraPersonClearLooks = EXTRA_PERSON_GONE_LOOKS;
  let talkingLooks = 0;
  let talkingReported = false;
  let talkingClearLooks = TALKING_GONE_LOOKS;
  let lastTalkingAt = -Infinity;
  let turnedLooks = 0;
  let turnedReported = false;
  let turnedClearLooks = LOOKING_AWAY_GONE_LOOKS;
  let lastTurnedAt = -Infinity;

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

      // face model or object model
      if (look.faces > 1 || look.extraBody) {
        extraPersonLooks += 1;
        extraPersonClearLooks = 0;
        if (extraPersonLooks >= EXTRA_PERSON_LOOKS && !extraPersonReported) {
          extraPersonReported = true;
          const detail = look.faces > 1 ? `${look.faces} faces in view of the camera` : "Someone else's shape seen in the background";
          verdicts.push({ kind: "extra_person", detail });
        }
      } else {
        extraPersonLooks = 0;
        extraPersonClearLooks += 1;
        if (extraPersonClearLooks >= EXTRA_PERSON_GONE_LOOKS) extraPersonReported = false;
      }

      // separate from extra_person's cooldown
      if ((look.faces > 1 || look.extraBody) && look.voice) {
        talkingLooks += 1;
        talkingClearLooks = 0;
        if (talkingLooks >= TALKING_LOOKS && !talkingReported && now - lastTalkingAt >= TALKING_COOLDOWN_MS) {
          talkingReported = true;
          lastTalkingAt = now;
          verdicts.push({ kind: "talking", detail: "Talking with someone next to the camera" });
        }
      } else {
        talkingLooks = 0;
        talkingClearLooks += 1;
        if (talkingClearLooks >= TALKING_GONE_LOOKS) talkingReported = false;
      }

      // don't reset on null
      if (look.turned !== null) {
        if (look.turned) {
          turnedLooks += 1;
          turnedClearLooks = 0;
          if (turnedLooks >= LOOKING_AWAY_LOOKS && !turnedReported && now - lastTurnedAt >= LOOKING_AWAY_COOLDOWN_MS) {
            turnedReported = true;
            lastTurnedAt = now;
            verdicts.push({ kind: "looking_away", detail: "Looked sharply away from the camera" });
          }
        } else {
          turnedLooks = 0;
          turnedClearLooks += 1;
          if (turnedClearLooks >= LOOKING_AWAY_GONE_LOOKS) turnedReported = false;
        }
      }

      if (look.phone === null) {
        return verdicts;
      }

      phoneWindow.push(look.phone);
      if (phoneWindow.length > PHONE_WINDOW) phoneWindow.shift();
      const phoneHits = phoneWindow.filter(Boolean).length;

      if (look.phone) {
        clearLooks = 0;
        if (phoneHits >= PHONE_LOOKS && !phoneReported && now - lastPhoneAt >= PHONE_COOLDOWN_MS) {
          phoneReported = true;
          lastPhoneAt = now;
          verdicts.push({ kind: "phone_seen", detail: "A phone is in view of the camera" });
        }
      } else {
        clearLooks += 1;
        if (clearLooks >= PHONE_GONE_LOOKS) phoneReported = false;
      }

      return verdicts;
    },
  };
}
