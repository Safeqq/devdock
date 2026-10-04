import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createLocalApiServer } from "../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../apps/daemon/dist/service-runtime-manager.js";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
} from "../packages/platform/dist/index.js";
import { RegistryDatabase } from "../packages/storage/dist/index.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDirectory = join(repositoryRoot, "artifacts");
const environmentFileName = ".env.portfolio-self-host";
const environmentFilePath = join(repositoryRoot, environmentFileName);

function cleanupRoot(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("devdock-self-host-"));
  return root;
}

async function availablePort(excluded = new Set()) {
  while (true) {
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
    if (!excluded.has(address.port)) return address.port;
  }
}

async function jsonRequest(origin, path, options = {}, expectedStatus = 200) {
  const response = await fetch(`${origin}${path}`, {
    signal: AbortSignal.timeout(10_000),
    ...options,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status assertion below is enough for an unexpected non-JSON response.
  }
  assert.equal(
    response.status,
    expectedStatus,
    `${options.method ?? "GET"} ${path} returned ${response.status}`,
  );
  return { response, body };
}

function mutation(origin, cookie, csrfToken, body) {
  return {
    method: "POST",
    headers: {
      origin,
      cookie,
      "x-devdock-csrf": csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function waitForReady(origin, serviceId, cookie) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const { body } = await jsonRequest(`${origin}`, `/api/services/${serviceId}/status`, {
      headers: { cookie },
    });
    if (
      body?.snapshot?.processState === "running" &&
      body.snapshot.readinessState === "ready" &&
      body.ownership === "owned"
    ) {
      return body;
    }
    if (
      body?.snapshot?.processState === "failed" ||
      body?.snapshot?.processState === "exited" ||
      body?.snapshot?.readinessState === "unhealthy"
    ) {
      throw new Error("Self-hosted service became terminal before readiness");
    }
    await delay(100);
  }
  throw new Error("Self-hosted service did not become ready within 40 seconds");
}

function apiReadyMarker(events, expectedOrigin) {
  for (const event of events) {
    if (event.stream !== "stdout") continue;
    try {
      const parsed = JSON.parse(event.text);
      if (
        parsed.type === "api-ready" &&
        parsed.origin === expectedOrigin &&
        typeof parsed.pairingCode === "string" &&
        parsed.pairingCode.length > 0
      ) {
        return { pairingCode: parsed.pairingCode };
      }
    } catch {
      // npm emits ordinary informational lines around the structured ready event.
    }
  }
  return null;
}

async function waitForApiReadyMarker(runtime, runId, expectedOrigin) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const replay = runtime.logBuffers.get(runId)?.replay(0);
    if (replay !== undefined) {
      const marker = apiReadyMarker(replay.events, expectedOrigin);
      if (marker !== null) return { marker, replay };
    }
    await delay(50);
  }
  throw new Error("Self-hosted API ready marker was not retained in the bounded log buffer");
}

async function tcpOpen(port) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (openState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveConnection(openState);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitForPortToClose(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await tcpOpen(port))) return;
    await delay(100);
  }
  throw new Error("Self-hosted API port remained open after Stop");
}

async function main() {
  if (!productionProcessControlAvailable()) {
    throw new Error("The current platform has no production process adapter");
  }

  const tempRoot = cleanupRoot(await mkdtemp(join(tmpdir(), "devdock-self-host-")));
  let store;
  let api;
  let environmentCreated = false;
  try {
    store = await RegistryDatabase.open(join(tempRoot, "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => createPlatformProcessAdapter(),
      daemonSessionId: "portfolio-self-host",
    });
    api = createLocalApiServer({ registry, launcher, runtime });
    const origin = await api.listen(0);
    const controllerPort = Number(new URL(origin).port);
    const expectedPort = await availablePort(new Set([controllerPort]));

    const environmentHandle = await open(environmentFilePath, "wx", 0o600);
    environmentCreated = true;
    try {
      await environmentHandle.writeFile(`DEVDOCK_PORT=${expectedPort}\n`, "utf8");
    } finally {
      await environmentHandle.close();
    }

    const paired = await jsonRequest(
      origin,
      "/api/pair",
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ code: api.pairingCode }),
      },
      200,
    );
    const cookieHeader = paired.response.headers.get("set-cookie");
    assert.notEqual(cookieHeader, null);
    const cookie = cookieHeader.split(";", 1)[0];
    const csrfToken = paired.body?.csrfToken;
    assert.equal(typeof csrfToken, "string");

    const registered = await jsonRequest(
      origin,
      "/api/projects",
      mutation(origin, cookie, csrfToken, {
        path: repositoryRoot,
        displayName: "DevDock",
      }),
      201,
    );
    const project = registered.body?.project;
    assert.equal(typeof project?.id, "string");

    const discovered = await jsonRequest(origin, `/api/projects/${project.id}/scripts`, {
      headers: { cookie },
    });
    assert.equal(discovered.body?.discovery?.packageName, "devdock");
    assert.ok(discovered.body.discovery.scriptNames.includes("api:auth"));

    const selected = await jsonRequest(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, {
        scriptName: "api:auth",
        displayName: "DevDock auth API",
        expectedPort,
        readiness: { kind: "tcp", timeoutMs: 30_000 },
        envFiles: [environmentFileName],
        requiredEnvKeys: ["DEVDOCK_PORT"],
      }),
      201,
    );
    const service = selected.body?.service;
    assert.equal(typeof service?.id, "string");

    const diagnostics = await jsonRequest(origin, `/api/services/${service.id}/diagnostics`, {
      headers: { cookie },
    });
    assert.deepEqual(diagnostics.body?.port, { status: "available", port: expectedPort });
    assert.equal(diagnostics.body?.environment?.files?.[0]?.status, "loaded");
    assert.deepEqual(diagnostics.body?.environment?.keys, [
      { name: "DEVDOCK_PORT", present: true },
    ]);

    const preview = await jsonRequest(origin, `/api/services/${service.id}/preview`, {
      headers: { cookie },
    });
    assert.equal(preview.body?.command?.cwd, project.path.canonicalPath);
    assert.deepEqual(preview.body?.command?.args?.slice(-2), ["run", "api:auth"]);

    const exported = await jsonRequest(origin, `/api/projects/${project.id}/export`, {
      headers: { cookie },
    });
    assert.equal(exported.body?.format, "devdock.project-configuration");
    assert.equal(exported.body?.schemaVersion, 1);
    assert.deepEqual(exported.body?.services?.[0]?.cwd, []);
    assert.deepEqual(exported.body?.services?.[0]?.envFiles, [environmentFileName]);
    const exportedText = JSON.stringify(exported.body);
    assert.ok(!exportedText.includes(repositoryRoot));
    assert.ok(!exportedText.includes("DEVDOCK_PORT="));

    const started = await jsonRequest(
      origin,
      `/api/services/${service.id}/start`,
      mutation(origin, cookie, csrfToken, {}),
      202,
    );
    const startedSnapshot = started.body?.outcome?.snapshot;
    assert.equal(started.body?.outcome?.kind, "started");
    assert.equal(typeof startedSnapshot?.runId, "string");

    const ready = await waitForReady(origin, service.id, cookie);
    assert.equal(ready.snapshot.runId, startedSnapshot.runId);
    const serviceOrigin = `http://127.0.0.1:${expectedPort}`;
    const nestedSession = await fetch(`${serviceOrigin}/api/session`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(nestedSession.status, 401);

    const { marker, replay } = await waitForApiReadyMarker(
      runtime,
      startedSnapshot.runId,
      serviceOrigin,
    );
    assert.equal(replay.gap, false);

    const openApp = await jsonRequest(origin, `/api/services/${service.id}/open-app`, {
      headers: { cookie },
    });
    assert.equal(openApp.body?.url, `${serviceOrigin}/`);

    const stopped = await jsonRequest(
      origin,
      `/api/services/${service.id}/stop`,
      mutation(origin, cookie, csrfToken, {}),
    );
    assert.equal(stopped.body?.outcome?.kind, "stopped");
    assert.equal(stopped.body?.outcome?.snapshot?.runId, startedSnapshot.runId);
    await waitForPortToClose(expectedPort);

    const finalStatus = await jsonRequest(origin, `/api/services/${service.id}/status`, {
      headers: { cookie },
    });
    assert.equal(finalStatus.body?.snapshot?.processState, "stopped");
    assert.equal(finalStatus.body?.ownership, null);

    const report = {
      format: "devdock.portfolio-self-host",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      project: {
        displayName: "DevDock",
        selectedScript: "api:auth",
        cwd: [],
      },
      configuration: {
        expectedPort,
        environmentFileNames: [environmentFileName],
        requiredKeyNames: ["DEVDOCK_PORT"],
        readiness: { kind: "tcp", timeoutMs: 30_000 },
      },
      checks: {
        registration: "passed",
        scriptDiscovery: "passed",
        commandPreview: "passed",
        diagnostics: {
          portAvailableBeforeStart: true,
          environmentFileLoaded: true,
          requiredKeyPresent: true,
        },
        configurationExport: {
          versioned: true,
          relativeCwd: true,
          absolutePathOmitted: true,
          environmentValueOmitted: true,
        },
        start: {
          processState: ready.snapshot.processState,
          readinessState: ready.snapshot.readinessState,
          ownership: ready.ownership,
        },
        logs: {
          retainedEventCount: replay.events.length,
          gap: replay.gap,
          apiReadyMarkerObserved: true,
          pairingCodeOmitted: true,
        },
        nestedSessionWithoutCookieStatus: nestedSession.status,
        openAppLoopbackUrlMatched: true,
        stop: {
          outcome: stopped.body.outcome.kind,
          finalProcessState: finalStatus.body.snapshot.processState,
          ownershipReleased: finalStatus.body.ownership === null,
          expectedPortClosed: true,
        },
      },
      limitations: [
        "This is a self-host validation of the current trusted repository, not an external project.",
        "The selected script rebuilds the repository before starting the auth-only API.",
        "TCP readiness proves a loopback listener responds but does not identify that listener.",
        "Open App targets the API root; the auth-only service has no dashboard at that route.",
        "The npm launcher is the only package-manager launcher currently supported.",
      ],
    };
    const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
    for (const secret of [api.pairingCode, marker.pairingCode, cookie, csrfToken]) {
      assert.ok(!serializedReport.includes(secret));
    }
    assert.ok(!serializedReport.includes(repositoryRoot));

    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(
      join(artifactsDirectory, "portfolio-self-host-latest.json"),
      serializedReport,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "portfolio-self-host-complete",
        report: "artifacts/portfolio-self-host-latest.json",
        checks: {
          readiness: "passed",
          logs: "passed",
          openApp: "passed",
          stop: "passed",
          cleanup: "passed",
        },
      })}\n`,
    );
  } finally {
    try {
      await api?.close();
    } finally {
      try {
        store?.close();
      } finally {
        try {
          if (environmentCreated) await rm(environmentFilePath, { force: true });
        } finally {
          await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    }
  }
}

main().catch((caught) => {
  process.stderr.write(
    `${caught instanceof Error ? caught.stack : "Self-host verification failed"}\n`,
  );
  process.exitCode = 1;
});
