import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, cpus, platform, release, tmpdir, totalmem, version } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = fileURLToPath(new URL("./profile-daemon-worker.mjs", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../tests/fixtures/profile-workload.mjs", import.meta.url),
);
const normalLines = 500;
const floodLines = 12_000;
const floodBatchSize = 25;
const floodBatchDelayMs = 5;
const apiSamples = 200;

function cleanupRoot(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("devdock-profile-"));
  return root;
}

async function availablePort() {
  const reservation = createServer();
  await new Promise((resolveListen, reject) => {
    reservation.once("error", reject);
    reservation.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = reservation.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  await new Promise((resolveClose, reject) => {
    reservation.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

function boundedAppend(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-65_536);
}

function ipcClient(child, diagnostics) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const pending = new Map();
  child.on("message", (message) => {
    if (message === null || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "ready") {
      resolveReady(message);
      return;
    }
    if (message.type === "fatal") {
      rejectReady(new Error(message.message ?? "Profiling daemon failed"));
      return;
    }
    if (!("requestId" in message) || typeof message.requestId !== "string") return;
    const request = pending.get(message.requestId);
    if (request === undefined) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.type === "failed") {
      request.reject(new Error(message.message ?? "Profiling daemon request failed"));
    } else {
      request.resolve(message);
    }
  });
  child.once("exit", (code, signal) => {
    const failure = new Error(
      `Profiling daemon exited early (code ${String(code)}, signal ${String(signal)}).\n${diagnostics()}`,
    );
    rejectReady(failure);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
  });
  return {
    ready,
    request(type, timeoutMs = 5_000, payload = {}) {
      const requestId = randomUUID();
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          rejectPromise(new Error(`Profiling daemon ${type} request timed out`));
        }, timeoutMs);
        pending.set(requestId, { resolve: resolvePromise, reject: rejectPromise, timer });
        child.send({ type, requestId, ...payload }, (error) => {
          if (error === null) return;
          clearTimeout(timer);
          pending.delete(requestId);
          rejectPromise(error);
        });
      });
    },
  };
}

async function jsonRequest(url, options = {}, expectedStatus = 200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), ...options });
  const body = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Request ${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { response, body };
}

function mutation(origin, cookie, csrfToken) {
  return {
    method: "POST",
    headers: {
      origin,
      cookie,
      "x-devdock-csrf": csrfToken,
      "content-type": "application/json",
    },
    body: "{}",
  };
}

async function waitForReady(origin, serviceId, cookie) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { body } = await jsonRequest(`${origin}/api/services/${serviceId}/status`, {
      headers: { cookie },
    });
    if (body.snapshot?.readinessState === "ready" && body.ownership === "owned") return body;
    await delay(50);
  }
  throw new Error("Profiling service did not become ready");
}

function frameFields(block) {
  const fields = {};
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1).trimStart();
  }
  return fields;
}

async function connectProfileStream(origin, runId, cookie, mode, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(`${origin}/api/events?runId=${encodeURIComponent(runId)}&after=0`, {
    headers: { cookie },
    signal: controller.signal,
  });
  if (response.status !== 200 || response.body === null) {
    clearTimeout(timer);
    throw new Error(`Log stream returned ${response.status}`);
  }
  const reader = response.body.getReader();
  return {
    async collect() {
      const decoder = new TextDecoder();
      let text = "";
      let received = 0;
      let firstReceivedAt;
      let completedAt;
      let completion;
      let gap = null;
      let adapterDroppedBytes = 0;
      const latencies = [];
      try {
        while (completion === undefined) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`Log stream closed before ${mode} completed`);
          text += decoder.decode(chunk.value, { stream: true });
          let boundary = text.indexOf("\n\n");
          while (boundary !== -1) {
            const block = text.slice(0, boundary);
            text = text.slice(boundary + 2);
            boundary = text.indexOf("\n\n");
            if (block.startsWith(":")) continue;
            const fields = frameFields(block);
            if (fields.event === "gap") {
              gap = JSON.parse(fields.data);
              continue;
            }
            if (fields.event !== "log") continue;
            const envelope = JSON.parse(fields.data);
            const dropped = /\[DevDock (?:adapter|helper) dropped (\d+) log bytes\]/u.exec(
              envelope.text,
            );
            if (dropped !== null) adapterDroppedBytes += Number(dropped[1]);
            let event;
            try {
              event = JSON.parse(envelope.text);
            } catch {
              continue;
            }
            if (event.mode !== mode) continue;
            if (event.type === "profile-log") {
              const now = Date.now();
              firstReceivedAt ??= now;
              completedAt = now;
              received += 1;
              latencies.push(Math.max(0, now - event.emittedAtEpochMs));
            } else if (event.type === "profile-log-complete") {
              completedAt = Date.now();
              completion = event;
              break;
            }
          }
        }
        return {
          received,
          firstReceivedAt,
          completedAt,
          completion,
          gap,
          adapterDroppedBytes,
          latencies,
        };
      } finally {
        clearTimeout(timer);
        await reader.cancel().catch(() => undefined);
        controller.abort();
      }
    },
  };
}

function percentile(values, percentage) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function distribution(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
    maxMs: values.length === 0 ? null : Math.max(...values),
  };
}

async function measureApiLatency(origin, serviceId, cookie) {
  const values = [];
  for (let index = 0; index < apiSamples; index += 1) {
    const startedAt = performance.now();
    await jsonRequest(`${origin}/api/services/${serviceId}/status`, { headers: { cookie } });
    values.push(performance.now() - startedAt);
  }
  return values;
}

async function childMetrics(serviceOrigin) {
  return (await jsonRequest(`${serviceOrigin}/metrics`)).body;
}

async function waitForMode(serviceOrigin, mode) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const metrics = await childMetrics(serviceOrigin);
    if (metrics.results?.[mode] !== undefined) return metrics;
    await delay(25);
  }
  throw new Error(`${mode} profiling workload did not finish`);
}

async function waitForLogQuiescence(client, runId) {
  const deadline = Date.now() + 10_000;
  let previousSequence = -1;
  let stableSamples = 0;
  let latest;
  while (Date.now() < deadline) {
    const summary = await client.request("log-summary", 5_000, { runId });
    latest = summary;
    if (summary.latestSequence === previousSequence) {
      stableSamples += 1;
      if (stableSamples >= 5) return summary;
    } else {
      previousSequence = summary.latestSequence;
      stableSamples = 0;
    }
    await delay(100);
  }
  if (latest !== undefined) return latest;
  throw new Error("Flood log buffer could not be inspected");
}

async function sampleResources(client, serviceOrigin, sampling, daemonSamples, childSamples) {
  while (sampling.active) {
    const [daemon, child] = await Promise.allSettled([
      client.request("sample"),
      childMetrics(serviceOrigin),
    ]);
    if (daemon.status === "fulfilled") daemonSamples.push(daemon.value);
    if (child.status === "fulfilled") childSamples.push(child.value.resources);
    await delay(50);
  }
  const [daemon, child] = await Promise.allSettled([
    client.request("sample"),
    childMetrics(serviceOrigin),
  ]);
  if (daemon.status === "fulfilled") daemonSamples.push(daemon.value);
  if (child.status === "fulfilled") childSamples.push(child.value.resources);
}

function resourceSummary(samples) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples.at(-1);
  const elapsedMs = last.sampledAtEpochMs - first.sampledAtEpochMs;
  const cpuMicros =
    last.cpuUserMicros + last.cpuSystemMicros - first.cpuUserMicros - first.cpuSystemMicros;
  return {
    pid: first.pid,
    samples: samples.length,
    elapsedMs,
    baselineRssBytes: first.rssBytes,
    peakRssBytes: Math.max(...samples.map(({ rssBytes }) => rssBytes)),
    finalRssBytes: last.rssBytes,
    peakHeapUsedBytes: Math.max(...samples.map(({ heapUsedBytes }) => heapUsedBytes)),
    cpuUserMicros: last.cpuUserMicros - first.cpuUserMicros,
    cpuSystemMicros: last.cpuSystemMicros - first.cpuSystemMicros,
    cpuPercentOfOneCore: elapsedMs <= 0 ? null : rounded((cpuMicros / (elapsedMs * 1_000)) * 100),
  };
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function gitWorkingTreeDirty() {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim().length > 0 : null;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(timeoutMs, undefined, { ref: false }).then(() => {
      throw new Error("Profiling daemon did not exit after shutdown");
    }),
  ]);
}

async function main() {
  const tempRoot = cleanupRoot(await mkdtemp(join(tmpdir(), "devdock-profile-")));
  const projectPath = join(tempRoot, "project café & profiling");
  const databasePath = join(tempRoot, "data", "registry.sqlite");
  const expectedPort = await availablePort();
  let daemon;
  let client;
  let ready;
  let cookie;
  let csrfToken;
  let startedRunId;
  let daemonStdout = "";
  let daemonStderr = "";
  let sampling;
  let sampler;
  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(
      join(projectPath, "package.json"),
      `${JSON.stringify({ name: "devdock-profile-workload", private: true, scripts: { profile: "node workload.mjs" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(projectPath, "workload.mjs"),
      `await import(${JSON.stringify(pathToFileURL(fixturePath).href)});\n`,
      "utf8",
    );
    await writeFile(
      join(projectPath, ".env.profile"),
      `PORT=${expectedPort}\nPROFILE_NORMAL_LINES=${normalLines}\nPROFILE_FLOOD_LINES=${floodLines}\nPROFILE_FLOOD_BATCH_SIZE=${floodBatchSize}\nPROFILE_FLOOD_BATCH_DELAY_MS=${floodBatchDelayMs}\n`,
      "utf8",
    );

    daemon = spawn(
      process.execPath,
      [workerPath, projectPath, databasePath, String(expectedPort)],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    daemon.stdout.on("data", (chunk) => {
      daemonStdout = boundedAppend(daemonStdout, chunk);
    });
    daemon.stderr.on("data", (chunk) => {
      daemonStderr = boundedAppend(daemonStderr, chunk);
    });
    client = ipcClient(daemon, () => `${daemonStdout}\n${daemonStderr}`.trim());
    ready = await client.ready;

    const paired = await jsonRequest(
      `${ready.origin}/api/pair`,
      {
        method: "POST",
        headers: { origin: ready.origin, "content-type": "application/json" },
        body: JSON.stringify({ code: ready.pairingCode }),
      },
      200,
    );
    cookie = paired.response.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("Pairing response did not set a session cookie");
    csrfToken = paired.body.csrfToken;

    const started = await jsonRequest(
      `${ready.origin}/api/services/${ready.serviceId}/start`,
      mutation(ready.origin, cookie, csrfToken),
      202,
    );
    startedRunId = started.body.outcome.snapshot.runId;
    await waitForReady(ready.origin, ready.serviceId, cookie);
    const serviceOrigin = `http://127.0.0.1:${expectedPort}`;

    const daemonSamples = [];
    const childSamples = [];
    sampling = { active: true };
    sampler = sampleResources(client, serviceOrigin, sampling, daemonSamples, childSamples);

    const normalStream = await connectProfileStream(ready.origin, startedRunId, cookie, "normal");
    const normalCollection = normalStream.collect();
    await jsonRequest(`${serviceOrigin}/emit?mode=normal`, { method: "POST" }, 202);
    const apiLatencyPromise = measureApiLatency(ready.origin, ready.serviceId, cookie);
    const [normal, apiLatencies] = await Promise.all([normalCollection, apiLatencyPromise]);

    await jsonRequest(`${serviceOrigin}/emit?mode=flood`, { method: "POST" }, 202);
    const floodMetrics = await waitForMode(serviceOrigin, "flood");
    const flood = await waitForLogQuiescence(client, startedRunId);
    sampling.active = false;
    await sampler;
    sampler = undefined;

    const apiDistribution = distribution(apiLatencies);
    const logLatency = distribution(normal.latencies);
    const normalObservedDurationMs =
      normal.firstReceivedAt === undefined || normal.completedAt === undefined
        ? null
        : normal.completedAt - normal.firstReceivedAt;
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      commit: gitCommit(),
      workingTreeDirty: gitWorkingTreeDirty(),
      environment: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        osVersion: version(),
        node: process.version,
        cpuModel: cpus()[0]?.model.trim() ?? "unknown",
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      configuration: {
        services: 1,
        normalLines,
        floodLines,
        floodBatchSize,
        floodBatchDelayMs,
        apiSamples,
        logBufferMaxLines: 5_000,
        resourceSampleIntervalMs: 50,
      },
      results: {
        controlApi: {
          ...Object.fromEntries(
            Object.entries(apiDistribution).map(([key, value]) => [
              key,
              typeof value === "number" ? rounded(value) : value,
            ]),
          ),
          targetP95Ms: 200,
          hypothesisMet: apiDistribution.p95Ms !== null && apiDistribution.p95Ms < 200,
        },
        logs: {
          normal: {
            emitted: normalLines,
            receivedLive: normal.received,
            missingLive: normalLines - normal.received,
            sourceDurationMs: rounded(normal.completion.durationMs),
            observedDurationMs: normalObservedDurationMs,
            sourceRateLinesPerSecond: rounded((normalLines / normal.completion.durationMs) * 1_000),
            deliveredRateLinesPerSecond:
              normalObservedDurationMs === null || normalObservedDurationMs === 0
                ? null
                : rounded((normal.received / normalObservedDurationMs) * 1_000),
            latency: {
              ...logLatency,
              targetP95Ms: 500,
              hypothesisMet: logLatency.p95Ms !== null && logLatency.p95Ms < 500,
            },
            sourceBackpressureCount: normal.completion.backpressureCount,
            adapterDroppedBytes: normal.adapterDroppedBytes,
          },
          flood: {
            emitted: floodLines,
            retainedWorkloadEvents: flood.retainedWorkloadEvents.flood,
            unobservedWorkloadEvents: floodLines - flood.retainedWorkloadEvents.flood,
            retentionEvictedWorkloadEvents:
              flood.gap && flood.adapterDroppedBytes === 0
                ? floodLines - flood.retainedWorkloadEvents.flood
                : null,
            gapReported: flood.gap,
            gapOldestSequence: flood.oldestSequence,
            gapLatestSequence: flood.latestSequence,
            completionMarkerRetained: flood.completions.flood !== undefined,
            sourceDurationMs: rounded(floodMetrics.results.flood.durationMs),
            sourceRateLinesPerSecond: rounded(
              (floodLines / floodMetrics.results.flood.durationMs) * 1_000,
            ),
            sourceBackpressureCount: floodMetrics.results.flood.backpressureCount,
            adapterDroppedBytes: flood.adapterDroppedBytes,
          },
        },
        resources: {
          daemon: resourceSummary(daemonSamples),
          workloadChild: resourceSummary(childSamples),
        },
      },
      limitations: [
        "This is one local development-machine run, not a universal benchmark.",
        "Daemon sampling includes the API and runtime manager; workload-child sampling excludes the npm wrapper.",
        "CPU percentage is normalized to one logical core and can exceed 100 percent for multithreaded work.",
        "Retention eviction is intentional once the bounded 5000-line run buffer is exceeded.",
      ],
    };

    await mkdir(join(repositoryRoot, "artifacts"), { recursive: true });
    const reportPath = join(repositoryRoot, "artifacts", "profile-latest.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        type: "profile-complete",
        reportPath,
        apiP95Ms: report.results.controlApi.p95Ms,
        logP95Ms: report.results.logs.normal.latency.p95Ms,
        normalReceived: report.results.logs.normal.receivedLive,
        floodRetained: report.results.logs.flood.retainedWorkloadEvents,
        floodUnobserved: report.results.logs.flood.unobservedWorkloadEvents,
      })}\n`,
    );

    await jsonRequest(
      `${ready.origin}/api/services/${ready.serviceId}/stop`,
      mutation(ready.origin, cookie, csrfToken),
      200,
    );
    startedRunId = undefined;
    await client.request("shutdown", 10_000);
    await waitForExit(daemon, 5_000);
    daemon = undefined;
  } finally {
    if (sampling !== undefined) sampling.active = false;
    await sampler?.catch(() => undefined);
    if (
      daemon !== undefined &&
      ready !== undefined &&
      cookie !== undefined &&
      csrfToken !== undefined &&
      startedRunId !== undefined
    ) {
      await jsonRequest(
        `${ready.origin}/api/services/${ready.serviceId}/stop`,
        mutation(ready.origin, cookie, csrfToken),
        200,
      ).catch(() => undefined);
    }
    if (daemon !== undefined && client !== undefined) {
      await client.request("shutdown", 10_000).catch(() => undefined);
      await waitForExit(daemon, 5_000).catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((caught) => {
  process.stderr.write(`${caught instanceof Error ? caught.stack : "Profiling failed"}\n`);
  process.exitCode = 1;
});
