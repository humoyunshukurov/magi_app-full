import { describe, it, expect } from "vitest";
import { pingResponseSchema, launchPayloadSchema } from "./ipc";

describe("ipc schemas", () => {
  it("accepts a well-formed ping response", () => {
    const parsed = pingResponseSchema.parse({
      message: "pong from magi-core",
      core_version: "0.0.0",
    });
    expect(parsed.message).toBe("pong from magi-core");
  });

  it("rejects a malformed ping response", () => {
    expect(() => pingResponseSchema.parse({ message: 1 })).toThrow();
  });

  it("accepts a launch payload with a token, an exam id, both or neither", () => {
    expect(launchPayloadSchema.parse({ token: "stub", exam_id: 42 })).toEqual({ token: "stub", exam_id: 42 });
    expect(launchPayloadSchema.parse({ token: "stub", exam_id: null })).toEqual({ token: "stub", exam_id: null });
    expect(launchPayloadSchema.parse({ token: null, exam_id: 42 })).toEqual({ token: null, exam_id: 42 });
    expect(launchPayloadSchema.parse({ token: null, exam_id: null })).toEqual({ token: null, exam_id: null });
  });

  it("rejects a payload missing either field", () => {
    expect(launchPayloadSchema.safeParse({}).success).toBe(false);
    expect(launchPayloadSchema.safeParse({ token: "stub" }).success).toBe(false);
    expect(launchPayloadSchema.safeParse({ exam_id: 42 }).success).toBe(false);
  });
});
