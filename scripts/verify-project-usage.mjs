import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalStringArray(name) {
  const value = process.env[name];
  if (value === undefined) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error(`${name} must be a JSON array of non-empty strings`);
  }
  return parsed;
}

function projectConfiguration() {
  if (process.env.DEVDOCK_PORTFOLIO_CONFIRMED_TRUSTED !== "1") {
    throw new Error("Set DEVDOCK_PORTFOLIO_CONFIRMED_TRUSTED=1 for a deliberately trusted project");
  }
  const projectPath = requiredEnvironment("DEVDOCK_PORTFOLIO_PROJECT_PATH");
  if (!isAbsolute(projectPath)) {
    throw new Error("DEVDOCK_PORTFOLIO_PROJECT_PATH must be absolute");
  }
  const cwdInput = process.env.DEVDOCK_PORTFOLIO_CWD?.trim() || ".";
  if (isAbsolute(cwdInput)) throw new Error("DEVDOCK_PORTFOLIO_CWD must be relative");
  const cwd = cwdInput.split(/[\\/]/u).filter((segment) => segment !== "" && segment !== ".");
  if (cwd.some((segment) => segment === "..")) {
    throw new Error("DEVDOCK_PORTFOLIO_CWD cannot leave the project root");
  }
  const port = Number(requiredEnvironment("DEVDOCK_PORTFOLIO_PORT"));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DEVDOCK_PORTFOLIO_PORT must be an integer between 1 and 65535");
  }
  const readinessPath = process.env.DEVDOCK_PORTFOLIO_READINESS_PATH?.trim();
  if (readinessPath !== undefined && !readinessPath.startsWith("/")) {
    throw new Error("DEVDOCK_PORTFOLIO_READINESS_PATH must start with /");
  }
  return {
    projectPath,
    displayName: requiredEnvironment("DEVDOCK_PORTFOLIO_PROJECT_NAME"),
    scriptName: requiredEnvironment("DEVDOCK_PORTFOLIO_SCRIPT"),
    cwd,
    port,
    readiness:
      readinessPath === undefined
        ? { kind: "tcp", timeoutMs: 15_000 }
        : { kind: "http", path: readinessPath, timeoutMs: 15_000 },
    envFiles: optionalStringArray("DEVDOCK_PORTFOLIO_ENV_FILES_JSON"),
    requiredEnvKeys: optionalStringArray("DEVDOCK_PORTFOLIO_REQUIRED_KEYS_JSON"),
  };
}

function cleanupRoot(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("devdock-project-usage-"));
  return root;
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { body } = await jsonRequest(origin, `/api/services/${serviceId}/status`, {
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
      throw new Error("Trusted project service became terminal before readiness");
    }
    await delay(100);
  }
  throw new Error("Trusted project service did not become ready within 30 seconds");
}

async function waitForLogs(runtime, runId) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const replay = runtime.logBuffers.get(runId)?.replay(0);
    if (replay !== undefined && replay.events.length > 0) return replay;
    await delay(50);
  }
  throw new Error("Trusted project emitted no retained log events");
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
  throw new Error("Trusted project port remained open after Stop");
}

async function main() {
  if (!productionProcessControlAvailable()) {
    throw new Error("The current platform has no production process adapter");
  }
  const config = projectConfiguration();
  const [canonicalProjectPath, canonicalDevDockPath] = await Promise.all([
    realpath(config.projectPath),
    realpath(repositoryRoot),
  ]);
  if (canonicalProjectPath === canonicalDevDockPath) {
    throw new Error("The second portfolio project must be separate from DevDock");
  }

  const tempRoot = cleanupRoot(await mkdtemp(join(tmpdir(), "devdock-project-usage-")));
  let store;
  let api;
  try {
    store = await RegistryDatabase.open(join(tempRoot, "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => createPlatformProcessAdapter(),
      daemonSessionId: "portfolio-project-usage",
    });
    api = createLocalApiServer({ registry, launcher, runtime });
    const origin = await api.listen(0);

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
        path: canonicalProjectPath,
        displayName: config.displayName,
      }),
      201,
    );
    const project = registered.body?.project;
    assert.equal(typeof project?.id, "string");

    const cwdValue = config.cwd.join("/");
    const discoveryQuery = cwdValue === "" ? "" : `?cwd=${encodeURIComponent(cwdValue)}`;
    const discovered = await jsonRequest(
      origin,
      `/api/projects/${project.id}/scripts${discoveryQuery}`,
      { headers: { cookie } },
    );
    assert.ok(discovered.body?.discovery?.scriptNames?.includes(config.scriptName));

    const serviceInput = {
      scriptName: config.scriptName,
      displayName: `${config.displayName} ${config.scriptName}`,
      expectedPort: config.port,
      readiness: config.readiness,
      envFiles: config.envFiles,
      requiredEnvKeys: config.requiredEnvKeys,
      ...(cwdValue === "" ? {} : { cwd: cwdValue }),
    };
    const selected = await jsonRequest(
      origin,
      `/api/projects/${project.id}/services`,
      mutation(origin, cookie, csrfToken, serviceInput),
      201,
    );
    const service = selected.body?.service;
    assert.equal(typeof service?.id, "string");

    const diagnostics = await jsonRequest(origin, `/api/services/${service.id}/diagnostics`, {
      headers: { cookie },
    });
    assert.deepEqual(diagnostics.body?.port, { status: "available", port: config.port });
    assert.equal(diagnostics.body?.environment?.allRequiredKeysPresent, true);

    const preview = await jsonRequest(origin, `/api/services/${service.id}/preview`, {
      headers: { cookie },
    });
    const expectedCwd = await realpath(resolve(canonicalProjectPath, ...config.cwd));
    assert.equal(preview.body?.command?.cwd, expectedCwd);
    assert.deepEqual(preview.body?.command?.args?.slice(-2), ["run", config.scriptName]);

    const exported = await jsonRequest(origin, `/api/projects/${project.id}/export`, {
      headers: { cookie },
    });
    assert.equal(exported.body?.format, "devdock.project-configuration");
    assert.equal(exported.body?.schemaVersion, 1);
    assert.deepEqual(exported.body?.services?.[0]?.cwd, config.cwd);
    const exportedText = JSON.stringify(exported.body);
    assert.ok(!exportedText.includes(canonicalProjectPath));

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
    const serviceOrigin = `http://127.0.0.1:${config.port}`;
    const endpointPath = config.readiness.kind === "http" ? config.readiness.path : "/";
    const endpoint = await fetch(`${serviceOrigin}${endpointPath}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    assert.ok(endpoint.status >= 200 && endpoint.status < 300);

    const replay = await waitForLogs(runtime, startedSnapshot.runId);
    assert.equal(replay.gap, false);
    const streamCounts = { stdout: 0, stderr: 0 };
    for (const event of replay.events) streamCounts[event.stream] += 1;

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
    await waitForPortToClose(config.port);

    const finalStatus = await jsonRequest(origin, `/api/services/${service.id}/status`, {
      headers: { cookie },
    });
    assert.equal(finalStatus.body?.snapshot?.processState, "stopped");
    assert.equal(finalStatus.body?.ownership, null);

    const report = {
      format: "devdock.portfolio-project-usage",
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      project: {
        displayName: config.displayName,
        selectedScript: config.scriptName,
        cwd: config.cwd,
      },
      configuration: {
        expectedPort: config.port,
        readiness: config.readiness,
        environmentFileNames: config.envFiles,
        requiredKeyNames: config.requiredEnvKeys,
      },
      checks: {
        registration: "passed",
        scriptDiscovery: "passed",
        commandPreview: "passed",
        diagnostics: {
          portAvailableBeforeStart: true,
          allRequiredKeysPresent: true,
        },
        configurationExport: {
          versioned: true,
          relativeCwd: true,
          absolutePathOmitted: true,
        },
        start: {
          processState: ready.snapshot.processState,
          readinessState: ready.snapshot.readinessState,
          ownership: ready.ownership,
        },
        endpointStatus: endpoint.status,
        logs: {
          retainedEventCount: replay.events.length,
          streamCounts,
          gap: replay.gap,
          textOmitted: true,
        },
        openAppLoopbackUrlMatched: true,
        stop: {
          outcome: stopped.body.outcome.kind,
          finalProcessState: finalStatus.body.snapshot.processState,
          ownershipReleased: finalStatus.body.ownership === null,
          expectedPortClosed: true,
        },
      },
      limitations: [
        "Dependencies must already be installed; discovery and verification never install them.",
        "Only the deliberately selected npm script is exercised.",
        "Readiness proves the configured loopback endpoint responds but not listener identity.",
        "The service runs with DevDock's pinned Node.js and npm, which may differ from the project pin.",
      ],
    };
    const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
    for (const secret of [api.pairingCode, cookie, csrfToken]) {
      assert.ok(!serializedReport.includes(secret));
    }
    assert.ok(!serializedReport.includes(canonicalProjectPath));
    assert.ok(!serializedReport.includes(config.projectPath));

    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(
      join(artifactsDirectory, "portfolio-project-latest.json"),
      serializedReport,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({
        type: "portfolio-project-usage-complete",
        report: "artifacts/portfolio-project-latest.json",
        project: config.displayName,
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
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}

main().catch((caught) => {
  process.stderr.write(
    `${caught instanceof Error ? caught.stack : "Trusted project verification failed"}\n`,
  );
  process.exitCode = 1;
});
