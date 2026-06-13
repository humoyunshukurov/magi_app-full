// Typed IPC boundary (ADR-0002). Every payload crossing Tauri IPC is validated at runtime
// with zod, and each schema is tied to the Rust-generated type via `satisfies`, so drift
// between `magi-types` and the frontend is a compile error.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { PingResponse } from "./generated/PingResponse";

/** Runtime schema for the `ping` command result, pinned to the generated `PingResponse`. */
export const pingResponseSchema = z.object({
  message: z.string(),
  core_version: z.string(),
}) satisfies z.ZodType<PingResponse>;

/** Call the `ping` IPC command and validate the response. */
export async function ping(): Promise<PingResponse> {
  const raw = await invoke("ping");
  return pingResponseSchema.parse(raw);
}

/** Payload emitted by the Rust deep-link handler on `magi://launch?token=…` (ADR-0010). */
export const launchPayloadSchema = z.object({
  token: z.string(),
});

export type LaunchPayload = z.infer<typeof launchPayloadSchema>;

/** Event name the Rust core emits launch hand-offs on. */
export const LAUNCH_EVENT = "launch://received" as const;
