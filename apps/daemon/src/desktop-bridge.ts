import type { RunSnapshot } from "@devdock/contracts";
import type { ProfileRuntimeManager } from "./profile-runtime-manager.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { ServiceRuntimeManager } from "./service-runtime-manager.js";

// The tray lists at most this many projects; the rest are still counted in the total.
const MAX_SUMMARY_PROJECTS = 20;
// Run IDs already announced, remembered only to avoid repeating an alert for the same run.
const MAX_ALERTED_RUNS = 200;

export type DesktopEvent =
  | {
      type: "runtime-summary";
      active: number;
      projects: Array<{ name: string; active: number }>;
    }
  | { type: "script-alert"; title: string; body: string };

// Failures worth interrupting the user for, in the words a notification uses.
const alertWording: Record<string, { what: string; next: string }> = {
  PROCESS_EXITED_WITH_FAILURE: {
    what: "stopped with an error",
    next: "Open DevDock to see its output.",
  },
  SPAWN_ERROR: {
    what: "couldn't be started",
    next: "Check that Node.js and npm are installed.",
  },
  READINESS_TIMEOUT: {
    what: "didn't answer in time",
    next: "DevDock stopped it. Open DevDock to see its output.",
  },
};

function isActive(snapshot: RunSnapshot): boolean {
  return (
    snapshot.reconciliationState === "known" &&
    (snapshot.processState === "starting" ||
      snapshot.processState === "running" ||
      snapshot.processState === "stopping")
  );
}

// Tells the desktop shell what it shows outside the window: how many scripts are running, for the
// tray, and which ones just failed, for notifications. It also carries out the tray's
// "Stop all scripts". The shell gets plain text and counts, never paths or environment values.
export class DesktopBridge {
  readonly #registry: ProjectRegistry;
  readonly #runtime: ServiceRuntimeManager;
  readonly #profileRuntime: ProfileRuntimeManager;
  readonly #emit: (event: DesktopEvent) => void;
  readonly #active = new Map<string, boolean>();
  readonly #alerted: string[] = [];
  readonly #unsubscribe: () => void;
  #summaryQueued = false;
  #lastSummary: string | null = null;
  #closed = false;

  constructor(options: {
    registry: ProjectRegistry;
    runtime: ServiceRuntimeManager;
    profileRuntime: ProfileRuntimeManager;
    emit: (event: DesktopEvent) => void;
  }) {
    this.#registry = options.registry;
    this.#runtime = options.runtime;
    this.#profileRuntime = options.profileRuntime;
    this.#emit = options.emit;
    this.#unsubscribe = this.#runtime.subscribeAll((snapshot) => this.#observe(snapshot));
    this.#queueSummary();
  }

  // Stops running groups first, so they release their scripts in order, then every script that
  // is still active. One failure does not keep the others running.
  async stopAll(): Promise<void> {
    for (const project of this.#registry.listProjects()) {
      for (const profile of this.#registry.listProfiles(project.id)) {
        if (!this.#profileRuntime.busy(profile.id)) continue;
        try {
          await this.#profileRuntime.stop(profile.id);
        } catch {
          // The scripts themselves are still stopped below.
        }
      }
    }
    for (const [serviceId, active] of [...this.#active]) {
      if (!active) continue;
      try {
        await this.#runtime.stop(serviceId);
      } catch {
        // Its card shows what happened; the remaining scripts are still stopped.
      }
    }
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
  }

  #observe(snapshot: RunSnapshot): void {
    if (this.#closed) return;
    const active = isActive(snapshot);
    if (this.#active.get(snapshot.serviceId) !== active) {
      this.#active.set(snapshot.serviceId, active);
      this.#queueSummary();
    }
    const wording =
      snapshot.processState === "failed" && snapshot.reconciliationState === "known"
        ? alertWording[snapshot.failureReason ?? "PROCESS_EXITED_WITH_FAILURE"]
        : undefined;
    if (wording !== undefined && !this.#alerted.includes(snapshot.runId)) {
      this.#alerted.push(snapshot.runId);
      if (this.#alerted.length > MAX_ALERTED_RUNS) this.#alerted.shift();
      const names = this.#names(snapshot.serviceId);
      if (names !== null) {
        this.#emit({
          type: "script-alert",
          title: `${names.script} ${wording.what}`,
          body: `${names.project} · ${wording.next}`,
        });
      }
    }
  }

  #names(serviceId: string): { script: string; project: string } | null {
    try {
      const service = this.#registry.getService(serviceId);
      return {
        script: service.displayName,
        project: this.#registry.getProject(service.projectId).displayName,
      };
    } catch {
      return null;
    }
  }

  // Several snapshots often arrive together (a group starting); one summary covers them.
  #queueSummary(): void {
    if (this.#summaryQueued) return;
    this.#summaryQueued = true;
    setImmediate(() => {
      this.#summaryQueued = false;
      if (!this.#closed) this.#sendSummary();
    });
  }

  #sendSummary(): void {
    const perProject = new Map<string, number>();
    let total = 0;
    for (const [serviceId, active] of this.#active) {
      if (!active) continue;
      total += 1;
      const names = this.#names(serviceId);
      const project = names?.project ?? "Other";
      perProject.set(project, (perProject.get(project) ?? 0) + 1);
    }
    const projects = [...perProject]
      .map(([name, active]) => ({ name, active }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, MAX_SUMMARY_PROJECTS);
    const event: DesktopEvent = { type: "runtime-summary", active: total, projects };
    const serialized = JSON.stringify(event);
    if (serialized === this.#lastSummary) return;
    this.#lastSummary = serialized;
    this.#emit(event);
  }
}
