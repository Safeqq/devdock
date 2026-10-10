import {
  type Profile,
  type ProfileOperationSnapshot,
  reasonMessage,
  type Service,
  type ServiceStatus,
  safeOpenAppUrl,
} from "./api";
import type { ScriptKind } from "./scripts";

export type Tone = "idle" | "starting" | "ready" | "done" | "failed" | "unknown";

// Everything a script card shows about a run, in plain words.
export interface CardState {
  readonly label: string;
  readonly tone: Tone;
  // A process exists that Stop can end.
  readonly active: boolean;
  readonly canStart: boolean;
  readonly hasRun: boolean;
  readonly why: string | null;
  readonly meta: string | null;
  readonly url: string | null;
}

export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1_000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function duration(startIso: string, endIso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 1_000));
  if (seconds < 1) return "under a second";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

// The address Open uses: what the app printed when it agrees with the configured port (or no port
// is configured), otherwise the configured port. Mirrors the daemon's Open App rule.
export function appAddress(service: Service | null, status: ServiceStatus | undefined) {
  const printed = status?.appUrl ?? null;
  const port = service?.expectedPort;
  if (printed !== null) {
    const parsed = new URL(printed);
    if (port === undefined || Number(parsed.port) === port) return safeOpenAppUrl(printed);
  }
  return port === undefined ? null : safeOpenAppUrl(`http://127.0.0.1:${port}/`);
}

export function shortAddress(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.hostname}:${parsed.port}${path}`;
}

function failureExplanation(service: Service | null, reason: string, exitCode: number | null) {
  if (reason === "PROCESS_EXITED_WITH_FAILURE") {
    return exitCode === null
      ? "Stopped with an error. The output below shows what went wrong."
      : `Stopped with an error (exit code ${exitCode}). The output below shows what went wrong.`;
  }
  if (reason === "READINESS_TIMEOUT") {
    const where = service?.expectedPort === undefined ? "your app" : `port ${service.expectedPort}`;
    return `It started, but ${where} didn't answer in time, so DevDock stopped it. Check the port in Settings or allow more time.`;
  }
  if (reason === "SPAWN_ERROR") {
    return "DevDock couldn't start it. Check that Node.js and npm are installed.";
  }
  return reasonMessage(reason);
}

export function cardState(
  service: Service | null,
  status: ServiceStatus | undefined,
  kind: ScriptKind | null,
  now: number,
): CardState {
  const snapshot = status?.snapshot ?? null;
  const idle = {
    label: kind === "runs-once" ? "Never run" : "Not running",
    tone: "idle" as const,
    active: false,
    canStart: true,
    hasRun: false,
    why: null,
    meta: null,
    url: null,
  };
  if (snapshot === null) return idle;
  if (snapshot.reconciliationState === "unknown" || status?.ownership === "unknown") {
    return {
      ...idle,
      label: "Status unknown",
      tone: "unknown",
      canStart: false,
      hasRun: true,
      why: "DevDock restarted while this was running, so it can't tell whether it still is. If it is, close it yourself; DevDock won't start a second copy.",
    };
  }
  const url = appAddress(service, status);
  switch (snapshot.processState) {
    case "starting":
      return {
        ...idle,
        label: "Starting…",
        tone: "starting",
        active: true,
        canStart: false,
        hasRun: true,
      };
    case "running": {
      if (snapshot.readinessState === "checking") {
        const port = service?.expectedPort;
        return {
          ...idle,
          label: "Starting…",
          tone: "starting",
          active: true,
          canStart: false,
          hasRun: true,
          meta:
            port === undefined ? "Waiting for it to answer" : `Waiting for port ${port} to answer`,
        };
      }
      const ready =
        snapshot.readinessState === "ready" || (service?.readiness === undefined && url !== null);
      return {
        ...idle,
        label: ready ? "Running · Ready" : "Running",
        tone: "ready",
        active: true,
        canStart: false,
        hasRun: true,
        url,
        meta:
          ready || url !== null
            ? null
            : "Running. If it serves a page, add its port in Settings so you can open it.",
      };
    }
    case "stopping":
      return {
        ...idle,
        label: "Stopping…",
        tone: "starting",
        active: true,
        canStart: false,
        hasRun: true,
      };
    case "exited":
      return {
        ...idle,
        label: `Finished · ${ago(snapshot.endedAt ?? snapshot.startedAt, now)}`,
        tone: "done",
        hasRun: true,
        meta:
          snapshot.endedAt === undefined
            ? null
            : `Took ${duration(snapshot.startedAt, snapshot.endedAt)}`,
      };
    case "failed":
      return {
        ...idle,
        label: `Failed · ${ago(snapshot.endedAt ?? snapshot.startedAt, now)}`,
        tone: "failed",
        hasRun: true,
        why: failureExplanation(
          service,
          snapshot.failureReason ?? "PROCESS_EXITED_WITH_FAILURE",
          snapshot.exitCode ?? null,
        ),
      };
    default:
      return { ...idle, label: "Not running", hasRun: true };
  }
}

export function startLabel(kind: ScriptKind | null, state: CardState): string {
  if (!state.hasRun) return kind === "runs-once" ? "Run" : "Start";
  return kind === "runs-once" || state.tone === "failed" ? "Run again" : "Start";
}

// Start order of a group, following each script's "starts after" links.
export function groupOrder(profile: Profile): string[] {
  const remaining = new Map(profile.services.map((entry) => [entry.serviceId, entry.dependsOn]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining].find(([, dependsOn]) =>
      dependsOn.every((id) => order.includes(id) || !remaining.has(id)),
    );
    if (next === undefined) break;
    order.push(next[0]);
    remaining.delete(next[0]);
  }
  return [...order, ...remaining.keys()];
}

export interface GroupState {
  readonly label: string;
  readonly tone: Tone;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly startLabel: string;
  readonly why: string | null;
}

export function groupState(
  snapshot: ProfileOperationSnapshot | null,
  names: ReadonlyMap<string, string>,
): GroupState {
  const idle = {
    label: "Not running",
    tone: "idle" as const,
    canStart: true,
    canStop: false,
    startLabel: "Start group",
    why: null,
  };
  if (snapshot === null || snapshot.state === "stopped") return idle;
  const total = snapshot.services.length;
  const ready = snapshot.services.filter((entry) => entry.state === "ready").length;
  if (snapshot.state === "starting") {
    return {
      ...idle,
      label: `${ready} of ${total} ready`,
      tone: "starting",
      canStart: false,
      canStop: true,
    };
  }
  if (snapshot.state === "ready") {
    return { ...idle, label: "Running · Ready", tone: "ready", canStart: false, canStop: true };
  }
  if (snapshot.state === "stopping") {
    return { ...idle, label: "Stopping…", tone: "starting", canStart: false };
  }
  // Degraded: one script failed. Scripts that were already running before stay up, so Stop is
  // offered until they are stopped; otherwise the group can simply be retried.
  const failed = snapshot.services.find((entry) => entry.state === "failed");
  const retained = snapshot.services.some(
    (entry) => entry.origin !== "pending" && (entry.state === "ready" || entry.state === "failed"),
  );
  const who = failed === undefined ? "A script" : (names.get(failed.serviceId) ?? "A script");
  const reason = failed?.reason ?? snapshot.failureReason;
  return {
    label: "Didn't start",
    tone: "failed",
    canStart: !retained,
    canStop: retained,
    startLabel: "Try again",
    why:
      `${who} failed to start.${reason === undefined ? "" : ` ${reasonMessage(reason)}`}` +
      " Scripts the group started were stopped again.",
  };
}
