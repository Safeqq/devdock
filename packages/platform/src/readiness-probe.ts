import { request } from "node:http";
import { createConnection } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const ATTEMPT_TIMEOUT_MS = 500;
const RETRY_DELAY_MS = 100;

export type ReadinessProbeTarget =
  | { readonly kind: "tcp"; readonly port: number; readonly timeoutMs: number }
  | {
      readonly kind: "http";
      readonly port: number;
      readonly path: string;
      readonly timeoutMs: number;
    };

export type ReadinessProbeResult =
  | { readonly kind: "ready" }
  | { readonly kind: "unhealthy"; readonly reason: "timeout" }
  | { readonly kind: "aborted" };

function pause(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolvePause) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePause(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function tcpAttempt(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolveAttempt) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolveAttempt(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function httpAttempt(
  port: number,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolveAttempt) => {
    let settled = false;
    const probe = request(
      {
        host: LOOPBACK_HOST,
        port,
        path,
        method: "GET",
        agent: false,
        maxHeaderSize: 16_384,
        headers: { accept: "*/*", "user-agent": "DevDock-readiness" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        finish(status >= 200 && status < 300);
      },
    );
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!ready) probe.destroy();
      resolveAttempt(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    probe.once("error", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
    probe.end();
  });
}

export async function probeLoopbackReadiness(
  target: ReadinessProbeTarget,
  signal?: AbortSignal,
): Promise<ReadinessProbeResult> {
  const deadline = Date.now() + target.timeoutMs;
  while (!signal?.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: "unhealthy", reason: "timeout" };
    const attemptTimeout = Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
    const ready =
      target.kind === "tcp"
        ? await tcpAttempt(target.port, attemptTimeout, signal)
        : await httpAttempt(target.port, target.path, attemptTimeout, signal);
    if (signal?.aborted) return { kind: "aborted" };
    if (ready) return { kind: "ready" };
    const retryIn = Math.min(RETRY_DELAY_MS, deadline - Date.now());
    if (retryIn <= 0) return { kind: "unhealthy", reason: "timeout" };
    if (!(await pause(retryIn, signal))) return { kind: "aborted" };
  }
  return { kind: "aborted" };
}
