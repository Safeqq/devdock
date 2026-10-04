import { once } from "node:events";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const port = integerEnvironment("PORT", 0, 0, 65_535);
const normalLines = integerEnvironment("PROFILE_NORMAL_LINES", 500, 100, 10_000);
const normalBatchSize = integerEnvironment("PROFILE_NORMAL_BATCH_SIZE", 10, 1, 1_000);
const normalBatchDelayMs = integerEnvironment("PROFILE_NORMAL_BATCH_DELAY_MS", 20, 1, 1_000);
const floodLines = integerEnvironment("PROFILE_FLOOD_LINES", 12_000, 5_001, 100_000);
const floodBatchSize = integerEnvironment("PROFILE_FLOOD_BATCH_SIZE", 25, 1, 1_000);
const floodBatchDelayMs = integerEnvironment("PROFILE_FLOOD_BATCH_DELAY_MS", 5, 1, 1_000);
const payload = "x".repeat(80);
const results = {};
let activeMode = null;

function resourceSnapshot() {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    sampledAtEpochMs: Date.now(),
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

async function writeLine(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
    await once(process.stdout, "drain");
    return true;
  }
  return false;
}

async function emit(mode) {
  activeMode = mode;
  const lines = mode === "normal" ? normalLines : floodLines;
  const startedAtEpochMs = Date.now();
  const startedAt = performance.now();
  const startingCpu = process.cpuUsage();
  let backpressureCount = 0;
  try {
    for (let index = 1; index <= lines; index += 1) {
      const backpressured = await writeLine({
        type: "profile-log",
        mode,
        index,
        emittedAtEpochMs: Date.now(),
        payload,
      });
      if (backpressured) backpressureCount += 1;
      if (mode === "normal" && index % normalBatchSize === 0) {
        await delay(normalBatchDelayMs);
      } else if (mode === "flood" && index % floodBatchSize === 0) {
        await delay(floodBatchDelayMs);
      }
    }
    const cpu = process.cpuUsage(startingCpu);
    const result = {
      mode,
      lines,
      startedAtEpochMs,
      completedAtEpochMs: Date.now(),
      durationMs: performance.now() - startedAt,
      backpressureCount,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    };
    await writeLine({ type: "profile-log-complete", ...result });
    results[mode] = result;
  } finally {
    activeMode = null;
  }
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/ready") {
    sendJson(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/metrics") {
    sendJson(response, 200, {
      activeMode,
      results,
      resources: resourceSnapshot(),
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/emit") {
    const mode = url.searchParams.get("mode");
    if (mode !== "normal" && mode !== "flood") {
      sendJson(response, 400, { error: "mode must be normal or flood" });
      return;
    }
    if (activeMode !== null || results[mode] !== undefined) {
      sendJson(response, 409, { error: "workload mode is already active or complete" });
      return;
    }
    void emit(mode).catch((caught) => {
      process.stderr.write(
        `${caught instanceof Error ? caught.message : "Profiling workload failed"}\n`,
      );
      process.exitCode = 1;
    });
    sendJson(response, 202, { accepted: true, mode });
    return;
  }
  sendJson(response, 404, { error: "not found" });
});

server.listen({ host: "127.0.0.1", port }, async () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Profiling workload did not receive a TCP address");
  }
  await writeLine({ type: "profile-listening", pid: process.pid, port: address.port });
});

function close() {
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
