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

  it("accepts a launch payload and rejects a missing token", () => {
    expect(launchPayloadSchema.parse({ token: "stub" }).token).toBe("stub");
    expect(launchPayloadSchema.safeParse({}).success).toBe(false);
  });
});
