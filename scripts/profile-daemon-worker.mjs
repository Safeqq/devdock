import { performance } from "node:perf_hooks";
import { createLocalApiServer } from "../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../apps/daemon/dist/service-runtime-manager.js";
import { createPlatformProcessAdapter, NpmLauncher } from "../packages/platform/dist/index.js";
import { RegistryDatabase } from "../packages/storage/dist/index.js";

function send(message, callback) {
  if (!process.connected) return;
  process.send?.(message, callback);
}

function resourceSnapshot(requestId) {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    type: "sample",
    requestId,
    pid: process.pid,
    sampledAtEpochMs: Date.now(),
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    eventLoopUtilization: performance.eventLoopUtilization().utilization,
  };
}

const [projectPath, databasePath, expectedPortText] = process.argv.slice(2);
const expectedPort = Number(expectedPortText);
if (
  projectPath === undefined ||
  databasePath === undefined ||
  !Number.isSafeInteger(expectedPort) ||
  expectedPort < 1 ||
  expectedPort > 65_535
) {
  throw new Error("Profiling daemon worker arguments are invalid");
}

let store;
let api;
let runtime;
let closing;

function logSummary(requestId, runId) {
  const logs = runtime?.logBuffers.get(runId);
  if (logs === undefined) {
    return { type: "failed", requestId, message: "Run log buffer is unavailable" };
  }
  const replay = logs.replay(0);
  const retainedWorkloadEvents = { normal: 0, flood: 0 };
  const completions = {};
  let adapterDroppedBytes = 0;
  for (const envelope of replay.events) {
    const dropped = /\[DevDock (?:adapter|helper) dropped (\d+) log bytes\]/u.exec(envelope.text);
    if (dropped !== null) adapterDroppedBytes += Number(dropped[1]);
    let event;
    try {
      event = JSON.parse(envelope.text);
    } catch {
      continue;
    }
    if (event.mode !== "normal" && event.mode !== "flood") continue;
    if (event.type === "profile-log") retainedWorkloadEvents[event.mode] += 1;
    if (event.type === "profile-log-complete") completions[event.mode] = event;
  }
  return {
    type: "log-summary",
    requestId,
    gap: replay.gap,
    oldestSequence: replay.oldestSequence,
    latestSequence: replay.latestSequence,
    retainedEvents: replay.events.length,
    retainedWorkloadEvents,
    completions,
    adapterDroppedBytes,
  };
}

async function closeResources() {
  if (closing !== undefined) return closing;
  closing = (async () => {
    await api?.close();
    api = undefined;
    store?.close();
    store = undefined;
  })();
  return closing;
}

async function main() {
  store = await RegistryDatabase.open(databasePath);
  const registry = new ProjectRegistry(store);
  const project = await registry.registerProject(projectPath, "Profiling workload");
  const service = await registry.selectService(project.id, "profile", {
    displayName: "Profiling workload",
    expectedPort,
    readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
    envFiles: [".env.profile"],
  });
  const launcher = await NpmLauncher.locate();
  runtime = new ServiceRuntimeManager({
    registry,
    launcher,
    adapterFactory: () => createPlatformProcessAdapter(),
    daemonSessionId: "phase-7-profile",
  });
  api = createLocalApiServer({ registry, launcher, runtime });
  const origin = await api.listen(0);
  send({
    type: "ready",
    origin,
    pairingCode: api.pairingCode,
    serviceId: service.id,
  });

  process.on("message", (message) => {
    if (message === null || typeof message !== "object" || !("type" in message)) return;
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (message.type === "sample" && typeof requestId === "string") {
      send(resourceSnapshot(requestId));
      return;
    }
    if (
      message.type === "log-summary" &&
      typeof requestId === "string" &&
      "runId" in message &&
      typeof message.runId === "string"
    ) {
      send(logSummary(requestId, message.runId));
      return;
    }
    if (message.type === "shutdown" && typeof requestId === "string") {
      void closeResources()
        .then(() => {
          send({ type: "closed", requestId }, () => process.disconnect());
        })
        .catch((caught) => {
          send({
            type: "failed",
            requestId,
            message: caught instanceof Error ? caught.message : "Daemon close failed",
          });
          process.exitCode = 1;
        });
    }
  });
  process.once("disconnect", () => {
    void closeResources().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGINT", () => {
    void closeResources();
  });
  process.once("SIGTERM", () => {
    void closeResources();
  });
}

main().catch(async (caught) => {
  send({
    type: "fatal",
    message: caught instanceof Error ? caught.message : "Profiling daemon failed",
  });
  await closeResources().catch(() => undefined);
  process.exitCode = 1;
});
