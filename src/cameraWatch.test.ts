import { describe, expect, it } from "vitest";
import { AWAY_MS, createJudge, type Look } from "./cameraWatch";

const face: Look = { faces: 1, phone: false };
const nobody: Look = { faces: 0, phone: false };
const phone: Look = { faces: 1, phone: true };
const twoFaces: Look = { faces: 2, phone: false };

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

  it("doesn't count a phone seen once", () => {
    const judge = createJudge();
    judge.feed(phone, 0);
    judge.feed(face, 2000);
    expect(judge.feed(phone, 4000)).toEqual([]);
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
    expect(judge.feed({ faces: 1, phone: null }, 1000)).toEqual([]);
    expect(judge.feed(phone, 2000)).toHaveLength(1);
  });

  it("still notices somebody leaving on a look that didn't check for a phone", () => {
    const judge = createJudge();
    judge.feed({ faces: 0, phone: null }, 0);
    expect(judge.feed({ faces: 0, phone: null }, AWAY_MS)).toHaveLength(1);
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
    expect(judge.feed({ faces: 2, phone: true }, 0)).toEqual([{ kind: "extra_person", detail: "2 faces in view of the camera" }]);
    expect(judge.feed({ faces: 2, phone: true }, 2000)).toEqual([{ kind: "phone_seen", detail: "A phone is in view of the camera" }]);
  });
});
