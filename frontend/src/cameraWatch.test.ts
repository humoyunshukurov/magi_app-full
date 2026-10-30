import { describe, expect, it } from "vitest";
import { AWAY_MS, createJudge, headTurned, type Look } from "./cameraWatch";

// BlazeFace's keypoint order: [right eye, left eye, nose tip, mouth, right ear, left ear] - only
// the first three matter here, the rest can be anything.
const keypoints = (rightEyeX: number, leftEyeX: number, noseX: number) => [
  { x: rightEyeX, y: 0.4 },
  { x: leftEyeX, y: 0.4 },
  { x: noseX, y: 0.5 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

describe("headTurned", () => {
  it("says no when the nose sits centered between the eyes", () => {
    expect(headTurned(keypoints(0.3, 0.5, 0.4))).toBe(false);
  });

  it("says yes when the nose has shifted toward one eye", () => {
    expect(headTurned(keypoints(0.3, 0.5, 0.32))).toBe(true);
    expect(headTurned(keypoints(0.3, 0.5, 0.48))).toBe(true);
  });

  it("tolerates an ordinary head angle short of a sharp turn", () => {
    expect(headTurned(keypoints(0.3, 0.5, 0.38))).toBe(false);
    expect(headTurned(keypoints(0.3, 0.5, 0.42))).toBe(false);
  });

  it("says unknown when the eyes are too close together to trust", () => {
    expect(headTurned(keypoints(0.5, 0.505, 0.5))).toBe(null);
  });

  it("says unknown when a keypoint is missing", () => {
    expect(headTurned([{ x: 0.3, y: 0.4 }])).toBe(null);
  });
});

const face: Look = { faces: 1, phone: false, voice: null, turned: false, extraBody: null };
const nobody: Look = { faces: 0, phone: false, voice: null, turned: null, extraBody: null };
const phone: Look = { faces: 1, phone: true, voice: null, turned: false, extraBody: null };
const twoFaces: Look = { faces: 2, phone: false, voice: null, turned: null, extraBody: null };
const talking: Look = { faces: 2, phone: false, voice: true, turned: null, extraBody: null };
const turnedAway: Look = { faces: 1, phone: false, voice: null, turned: true, extraBody: null };
const bodySeen: Look = { faces: 1, phone: false, voice: null, turned: false, extraBody: true };

describe("createJudge, being away from the camera", () => {
  it("says nothing while somebody is in front of the camera", () => {
    const judge = createJudge();
    for (let t = 0; t < 10_000; t += 1000) expect(judge.feed(face, t)).toEqual([]);
  });

  it("reports leaving once nobody has been there for a few seconds, and only once", () => {
    const judge = createJudge();
    expect(judge.feed(nobody, 0)).toEqual([]);
    expect(judge.feed(nobody, AWAY_MS - 1000)).toEqual([]);
    expect(judge.feed(nobody, AWAY_MS)).toEqual([{ kind: "camera_away", detail: "Nobody in front of the camera" }]);
    expect(judge.feed(nobody, AWAY_MS + 1000)).toEqual([]);
    expect(judge.feed(nobody, AWAY_MS + 5000)).toEqual([]);
  });

  it("reports the return, with how long it was", () => {
    const judge = createJudge();
    judge.feed(nobody, 0);
    judge.feed(nobody, 3000);
    expect(judge.feed(face, 8000)).toEqual([{ kind: "camera_back", detail: "Back in front of the camera after 8 s", awaySeconds: 8 }]);
    expect(judge.feed(face, 9000)).toEqual([]);
  });

  it("ignores a short gap, such as a missed look or a moment of leaning away", () => {
    const judge = createJudge();
    judge.feed(nobody, 0);
    judge.feed(nobody, 1000);
    expect(judge.feed(face, 2000)).toEqual([]);
    judge.feed(nobody, 3000);
    expect(judge.feed(nobody, 4000)).toEqual([]);
  });

  it("reports leaving again after coming back", () => {
    const judge = createJudge();
    judge.feed(nobody, 0);
    judge.feed(nobody, 3000);
    judge.feed(face, 4000);
    judge.feed(nobody, 5000);
    expect(judge.feed(nobody, 8000)).toEqual([{ kind: "camera_away", detail: "Nobody in front of the camera" }]);
  });
});

describe("createJudge, a phone", () => {
  it("wants two looks in a row before it believes there is a phone", () => {
    const judge = createJudge();
    expect(judge.feed(phone, 0)).toEqual([]);
    expect(judge.feed(phone, 2000)).toEqual([{ kind: "phone_seen", detail: "A phone is in view of the camera" }]);
  });

  it("doesn't count a single phone look with nothing around it", () => {
    const judge = createJudge();
    expect(judge.feed(phone, 0)).toEqual([]);
  });

  it("still counts it with one flaky miss in between, instead of demanding back-to-back hits", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(face, 2000);
    expect(judge.feed(phone, 4000)).toEqual([{ kind: "phone_seen", detail: "A phone is in view of the camera" }]);
  });

  it("needs at least two hits, not just one surrounded by misses", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(face, 2000);
    expect(judge.feed(face, 4000)).toEqual([]);
  });

  it("reports one phone once, however long it stays in view", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(phone, 2000);
    for (let t = 4000; t < 30_000; t += 2000) expect(judge.feed(phone, t)).toEqual([]);
  });

  it("reports it again when it comes back later", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(phone, 2000);
    for (const t of [4000, 6000, 8000]) judge.feed(face, t);
    judge.feed(phone, 20_000);
    expect(judge.feed(phone, 22_000)).toHaveLength(1);
  });

  it("doesn't report it again within a few seconds, even if it flickers", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(phone, 2000);
    for (const t of [3000, 4000, 5000]) judge.feed(face, t);
    judge.feed(phone, 6000);
    expect(judge.feed(phone, 7000)).toEqual([]);
  });

  it("keeps counting across looks that didn't check for a phone", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    expect(judge.feed({ faces: 1, phone: null, voice: null, turned: null, extraBody: null }, 1000)).toEqual([]);
    expect(judge.feed(phone, 2000)).toHaveLength(1);
  });

  it("still notices somebody leaving on a look that didn't check for a phone", () => {
    const judge = createJudge();
    judge.feed({ faces: 0, phone: null, voice: null, turned: null, extraBody: null }, 0);
    expect(judge.feed({ faces: 0, phone: null, voice: null, turned: null, extraBody: null }, AWAY_MS)).toHaveLength(1);
  });
});

describe("createJudge, an extra person", () => {
  it("reports a second face the moment it's seen, not after a few looks", () => {
    const judge = createJudge();
    expect(judge.feed(twoFaces, 0)).toEqual([{ kind: "extra_person", detail: "2 faces in view of the camera" }]);
  });

  it("doesn't keep reporting while the extra person stays in view", () => {
    const judge = createJudge();
    judge.feed(twoFaces, 0);
    for (let t = 1000; t < 10_000; t += 1000) expect(judge.feed(twoFaces, t)).toEqual([]);
  });

  it("reports it again once they've left and come back", () => {
    const judge = createJudge();
    judge.feed(twoFaces, 0);
    judge.feed(face, 1000);
    judge.feed(face, 2000);
    expect(judge.feed(twoFaces, 3000)).toEqual([{ kind: "extra_person", detail: "2 faces in view of the camera" }]);
  });

  it("doesn't report it again on a single flicker back to one face", () => {
    const judge = createJudge();
    judge.feed(twoFaces, 0);
    judge.feed(face, 1000);
    expect(judge.feed(twoFaces, 2000)).toEqual([]);
  });

  it("is independent of the camera-away and phone checks", () => {
    const judge = createJudge();
    expect(judge.feed({ faces: 2, phone: true, voice: null, turned: null, extraBody: null }, 0)).toEqual([{ kind: "extra_person", detail: "2 faces in view of the camera" }]);
    expect(judge.feed({ faces: 2, phone: true, voice: null, turned: null, extraBody: null }, 2000)).toEqual([{ kind: "phone_seen", detail: "A phone is in view of the camera" }]);
  });

  it("also reports it from a second person-shaped object, when the face model saw only one face", () => {
    const judge = createJudge();
    expect(judge.feed(bodySeen, 0)).toEqual([{ kind: "extra_person", detail: "Someone else's shape seen in the background" }]);
  });

  it("doesn't report a body seen alone without it being a second one (the student is a body too)", () => {
    const judge = createJudge();
    const soloBody: Look = { faces: 1, phone: false, voice: null, turned: false, extraBody: false };
    expect(judge.feed(soloBody, 0)).toEqual([]);
  });
});

// a second face on its own already reports extra_person (see above) - these only care whether
// "talking" specifically shows up alongside it, not the full verdict list for a given look
const talks = (verdicts: { kind: string }[]) => verdicts.some((v) => v.kind === "talking");

describe("createJudge, talking", () => {
  it("reports after a few looks with a second face and voice activity at once", () => {
    const judge = createJudge();
    expect(talks(judge.feed(talking, 0))).toBe(false);
    expect(talks(judge.feed(talking, 500))).toBe(false);
    expect(judge.feed(talking, 1000)).toContainEqual({ kind: "talking", detail: "Talking with someone next to the camera" });
  });

  it("doesn't report a second face alone, without voice", () => {
    const judge = createJudge();
    for (let t = 0; t < 3000; t += 500) expect(talks(judge.feed(twoFaces, t))).toBe(false);
  });

  it("doesn't report voice activity alone, without a second face", () => {
    const judge = createJudge();
    const soloVoice: Look = { faces: 1, phone: false, voice: true, turned: null, extraBody: null };
    for (let t = 0; t < 3000; t += 500) expect(talks(judge.feed(soloVoice, t))).toBe(false);
  });

  it("doesn't report it again within the cooldown, even if it flickers", () => {
    const judge = createJudge();
    judge.feed(talking, 0);
    judge.feed(talking, 500);
    judge.feed(talking, 1000);
    judge.feed(twoFaces, 1500);
    judge.feed(talking, 2000);
    judge.feed(talking, 2500);
    expect(talks(judge.feed(talking, 3000))).toBe(false);
  });

  it("reports it again once they've stopped for a while, come back, and the cooldown has passed", () => {
    const judge = createJudge();
    judge.feed(talking, 0);
    judge.feed(talking, 500);
    judge.feed(talking, 1000);
    for (const t of [1500, 2000, 2500]) judge.feed(twoFaces, t);
    judge.feed(talking, 20_000);
    judge.feed(talking, 20_500);
    expect(judge.feed(talking, 21_000)).toContainEqual({ kind: "talking", detail: "Talking with someone next to the camera" });
  });
});

const looksAway = (verdicts: { kind: string }[]) => verdicts.some((v) => v.kind === "looking_away");

describe("createJudge, looking away", () => {
  it("reports after a few looks turned sharply away in a row", () => {
    const judge = createJudge();
    expect(looksAway(judge.feed(turnedAway, 0))).toBe(false);
    expect(looksAway(judge.feed(turnedAway, 500))).toBe(false);
    expect(looksAway(judge.feed(turnedAway, 1000))).toBe(false);
    expect(judge.feed(turnedAway, 1500)).toContainEqual({ kind: "looking_away", detail: "Looked sharply away from the camera" });
  });

  it("doesn't report a single glance, it resets as soon as they face forward again", () => {
    const judge = createJudge();
    judge.feed(turnedAway, 0);
    judge.feed(turnedAway, 500);
    judge.feed(face, 1000);
    expect(looksAway(judge.feed(turnedAway, 1500))).toBe(false);
  });

  it("doesn't count a look where turned is unknown (no single clear face), but doesn't reset either", () => {
    const judge = createJudge();
    judge.feed(turnedAway, 0);
    judge.feed(turnedAway, 500);
    judge.feed(twoFaces, 1000); // turned: null - momentary overlap, not a reason to start over
    judge.feed(turnedAway, 1500);
    expect(judge.feed(turnedAway, 2000)).toContainEqual({ kind: "looking_away", detail: "Looked sharply away from the camera" });
  });

  it("doesn't report it again within the cooldown, even if it flickers", () => {
    const judge = createJudge();
    judge.feed(turnedAway, 0);
    judge.feed(turnedAway, 500);
    judge.feed(turnedAway, 1000);
    judge.feed(turnedAway, 1500);
    judge.feed(face, 2000);
    judge.feed(turnedAway, 2500);
    judge.feed(turnedAway, 3000);
    judge.feed(turnedAway, 3500);
    expect(looksAway(judge.feed(turnedAway, 4000))).toBe(false);
  });

  it("reports it again once they've faced forward for a while, turned away again, and the cooldown has passed", () => {
    const judge = createJudge();
    judge.feed(turnedAway, 0);
    judge.feed(turnedAway, 500);
    judge.feed(turnedAway, 1000);
    judge.feed(turnedAway, 1500);
    for (const t of [2000, 2500, 3000]) judge.feed(face, t);
    judge.feed(turnedAway, 20_000);
    judge.feed(turnedAway, 20_500);
    judge.feed(turnedAway, 21_000);
    expect(judge.feed(turnedAway, 21_500)).toContainEqual({ kind: "looking_away", detail: "Looked sharply away from the camera" });
  });
});
