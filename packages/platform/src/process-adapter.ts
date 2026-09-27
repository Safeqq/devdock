import type { Readable } from "node:stream";

export interface SpawnRequest {
  readonly runId: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly canonicalCwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type GracefulStopCapability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export interface ManagedProcessHandle {
  readonly runId: string;
  readonly pid: number;
  readonly identity: string;
  // Adapter-owned, non-serializable evidence. Never recreate this handle from stored PID data.
  readonly ownership: object;
  readonly gracefulStop: GracefulStopCapability;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export type OwnershipInspection = "owned" | "exited" | "unknown";
export type StopRequestResult =
  | "requested"
  | "already_exited"
  | "ownership_unknown"
  | "unsupported";
export type WaitForExitResult =
  | { readonly kind: "exited"; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: "timeout" }
  | { readonly kind: "unknown"; readonly reason: string };

export interface ProcessAdapter {
  start(request: SpawnRequest): Promise<ManagedProcessHandle>;
  inspectOwnership(handle: ManagedProcessHandle): Promise<OwnershipInspection>;
  requestGracefulStop(handle: ManagedProcessHandle): Promise<StopRequestResult>;
  terminateOwnedTree(handle: ManagedProcessHandle): Promise<StopRequestResult>;
  waitForExit(handle: ManagedProcessHandle, timeoutMs?: number): Promise<WaitForExitResult>;
}
