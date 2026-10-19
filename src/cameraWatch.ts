// Looks at the camera picture for what matters during an exam: a phone in view, nobody in front
// of the camera, more than one face in it, and (from the microphone, not the picture) whether
// there's voice activity while that second face is there. Everything runs on this computer
// (MediaPipe for video, the Web Audio API for voice level); no picture or audio ever leaves it.

/** What one look at the camera (and, for voice, the microphone) found. */
export interface Look {
  faces: number;
  /** null when this look didn't check for a phone */
  phone: boolean | null;
  /** null when there's no microphone to check */
  voice: boolean | null;
  /** Head turned sharply away from the camera - null when there isn't exactly one clear face to
   * judge it from (with zero or several faces, this isn't meaningful). */
  turned: boolean | null;
}

// BlazeFace's documented keypoint order for a face detection: right eye, left eye, nose tip,
// mouth center, right ear tragion, left ear tragion (in image space, not mirrored).
const RIGHT_EYE = 0;
const LEFT_EYE = 1;
const NOSE_TIP = 2;

/** The eyes are too close together in the frame (small, far away, or a bad angle) to trust the
 * nose-offset estimate below at all. */
const MIN_EYE_SPAN = 0.02;
/** How far off-center (0 = at the right eye, 1 = at the left eye, 0.5 = centered) the nose can
 * sit before this counts as a sharp turn, not just an ordinary head angle while thinking/reading. */
const TURN_LOW = 0.28;
const TURN_HIGH = 0.72;

/** A rough yaw estimate from the detector's own keypoints - no extra model, no extra cost, just
 * reading more of what BlazeFace already computed. Approximate by nature (no real 3D head pose),
 * which is why the judge below still demands this hold for several looks in a row. */
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
    // voice isn't this detector's job (it has no microphone) - useCameraWatch fills it in
    look: (picture, { phone }) => {
      const detections = face.detect(picture).detections;
      return {
        faces: detections.length,
        phone: phone ? objects.detect(picture).detections.length > 0 : null,
        voice: null,
        turned: detections.length === 1 ? headTurned(detections[0]!.keypoints) : null,
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
export const AWAY_MS = 3000;
/** Phone-check results worth remembering at once, oldest first. */
const PHONE_WINDOW = 3;
/** Hits needed within that window to believe there is a phone - out of the last PHONE_WINDOW
 * checks, not strictly back to back, so one flaky miss from the model doesn't throw away a real
 * detection (object detection on a phone held at an angle or partly out of frame is not perfectly
 * consistent look to look). */
const PHONE_LOOKS = 2;
/** Looks in a row without a phone before a phone can be reported again. */
const PHONE_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon. */
const PHONE_COOLDOWN_MS = 10_000;
/** A second face is reported the moment it's seen - even a quick walk-by matters here. */
const EXTRA_PERSON_LOOKS = 1;
/** Looks in a row back down to one face before an extra person can be reported again. */
const EXTRA_PERSON_GONE_LOOKS = 2;
/** Looks in a row with a second face AND voice activity at once, at 500ms each - about 1.5s of
 * an actual back-and-forth, not a cough or a one-off word that happened to overlap with someone
 * passing by. */
const TALKING_LOOKS = 3;
/** Looks in a row without that combination before talking can be reported again. */
const TALKING_GONE_LOOKS = 3;
/** The same thing isn't reported again this soon - a single conversation shouldn't spam incidents. */
const TALKING_COOLDOWN_MS = 15_000;
/** Looks in a row with the head turned sharply away, at 500ms each - a couple of seconds of it,
 * not a quick glance to the side while thinking. */
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

      // independent of extra_person's own report/cooldown above - this tracks the current
      // moment's condition (second face + voice) directly, not whether extra_person already fired
      if (look.faces > 1 && look.voice) {
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

      // null (not exactly one clear face) leaves this alone rather than resetting it - a brief
      // overlap with someone passing by shouldn't throw away an otherwise sustained turn
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
