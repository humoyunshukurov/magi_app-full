import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, listExams, login, logout, signup } from "./api";

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ status, json: () => Promise.resolve(body) } as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client envelope handling", () => {
  it("unwraps data on a successful login response", async () => {
    mockFetchOnce(200, {
      success: true,
      data: { token: "abc", user: { id: 1, first_name: "A", last_name: null, email: "a@b.com", role: "student" } },
    });
    const result = await login("a@b.com", "pw");
    expect(result.token).toBe("abc");
    expect(result.user.id).toBe(1);
  });

  it("unwraps message on a successful signup response with no data field", async () => {
    mockFetchOnce(200, { success: true, message: "User signed up successfully. Please verify your email address." });
    const message = await signup({ first_name: "A", email: "a@b.com", password: "Test1234!" });
    expect(message).toContain("signed up");
  });

  it("unwraps message on logout", async () => {
    mockFetchOnce(200, { success: true, message: "Logged out successfully" });
    const message = await logout("some-token");
    expect(message).toBe("Logged out successfully");
  });

  it("throws ApiError with the server's message on {success: false}", async () => {
    mockFetchOnce(400, { success: false, message: "Invalid email or password" });
    await expect(login("a@b.com", "wrong")).rejects.toThrow(ApiError);
    await expect(login("a@b.com", "wrong")).rejects.toThrow("Invalid email or password");
  });

  it("throws ApiError when the response doesn't even match the envelope shape", async () => {
    mockFetchOnce(200, { not: "an envelope" });
    await expect(listExams("token")).rejects.toThrow(ApiError);
  });

  it("parses ids as numbers, not bigint, since that's what's actually on the wire", async () => {
    mockFetchOnce(200, {
      success: true,
      data: [{ id: 9007199254740991, name: "E", scheduled_start: "2026-01-01T00:00:00Z", scheduled_end: "2026-01-01T01:00:00Z", status: "scheduled", max_marks: 100, passing_marks: 50 }],
    });
    const exams = await listExams("token");
    expect(typeof exams[0]?.id).toBe("number");
  });
});
