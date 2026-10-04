import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { createLocalApiServer } from "../apps/daemon/dist/local-api.js";
import { ProjectRegistry } from "../apps/daemon/dist/project-registry.js";
import { ServiceRuntimeManager } from "../apps/daemon/dist/service-runtime-manager.js";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
} from "../packages/platform/dist/index.js";
import { RegistryDatabase } from "../packages/storage/dist/index.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifactsDirectory = join(repositoryRoot, "artifacts");
const prepareDemoPath = fileURLToPath(new URL("./prepare-demo.mjs", import.meta.url));
const webRoot = fileURLToPath(new URL("../apps/web/dist/", import.meta.url));
const durationOverride = process.env.DEVDOCK_DEMO_SCENE_MS;
const outputPath = join(
  artifactsDirectory,
  durationOverride === undefined ? "devdock-demo.webm" : "devdock-demo-smoke.webm",
);
const reportPath = join(
  artifactsDirectory,
  durationOverride === undefined ? "demo-recording-latest.json" : "demo-recording-smoke.json",
);
const sceneMs = Number(durationOverride ?? "20000");

assert.ok(productionProcessControlAvailable(), "A production process adapter is required");
assert.ok(
  Number.isInteger(sceneMs) && sceneMs >= 500 && sceneMs <= 60_000,
  "DEVDOCK_DEMO_SCENE_MS must be an integer between 500 and 60000",
);

function safeTemporaryRoot(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("devdock-demo-recording-"));
  return root;
}

function safeGeneratedProject(path) {
  const root = resolve(path);
  assert.equal(dirname(root), resolve(artifactsDirectory));
  assert.ok(basename(root).startsWith("devdock-demo-"));
  return root;
}

async function browserExecutable() {
  const override = process.env.DEVDOCK_TEST_BROWSER;
  const candidates = override
    ? [override]
    : process.platform === "win32"
      ? [
          process.env["ProgramFiles(x86)"] &&
            join(
              process.env["ProgramFiles(x86)"],
              "Microsoft",
              "Edge",
              "Application",
              "msedge.exe",
            ),
          process.env.ProgramFiles &&
            join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error(
    "No supported system browser found; set DEVDOCK_TEST_BROWSER to an absolute Edge/Chrome path",
  );
}

async function prepareDemoProject() {
  const { stdout } = await execFileAsync(process.execPath, [prepareDemoPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const line = stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((entry) => entry.includes('"type":"demo-ready"'));
  if (line === undefined) throw new Error("Demo preparation did not report its configuration");
  const configuration = JSON.parse(line);
  assert.equal(configuration.type, "demo-ready");
  assert.equal(typeof configuration.projectPath, "string");
  for (const key of ["apiPort", "unhealthyPort", "sentinelPort"]) {
    assert.ok(Number.isInteger(configuration[key]));
  }
  return configuration;
}

function startFixture(projectPath, envFile, mode) {
  const diagnostics = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    [`--env-file=${join(projectPath, envFile)}`, join(projectPath, "service.mjs"), mode],
    {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const append = (key, chunk) => {
    diagnostics[key] = `${diagnostics[key]}${chunk.toString("utf8")}`.slice(-16_384);
  };
  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  return { child, diagnostics };
}

async function stopFixture(fixture) {
  if (
    fixture === undefined ||
    fixture.child.exitCode !== null ||
    fixture.child.signalCode !== null
  ) {
    return;
  }
  const exited = once(fixture.child, "exit");
  fixture.child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 3_000)),
  ]);
  if (graceful) return;
  fixture.child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Demo fixture did not exit after SIGKILL")), 3_000),
    ),
  ]);
}

async function waitForStatus(url, expectedStatus, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.status === expectedStatus) return response;
      lastError = new Error(`Endpoint returned ${response.status}`);
    } catch (caught) {
      lastError = caught;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(
    `Endpoint ${url} did not return ${expectedStatus}: ${
      lastError instanceof Error ? lastError.message : "unknown error"
    }`,
  );
}

async function waitForClosed(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
    } catch (caught) {
      if (caught instanceof Error && caught.name === "TimeoutError") continue;
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Endpoint stayed open after cleanup: ${url}`);
}

async function captureScene(page, sceneDirectory, name, focus, text) {
  if (focus === "top") {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  } else {
    await focus.evaluate((element) =>
      element.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  }
  await page.waitForTimeout(300);
  const path = join(sceneDirectory, `${name}.png`);
  await page.screenshot({ path, type: "png" });
  return { imagePath: path, ...text };
}

async function renderRecording(context, scenes) {
  const page = await context.newPage();
  const chunks = [];
  await page.exposeFunction("appendDemoVideoChunk", (base64) => {
    chunks.push(Buffer.from(base64, "base64"));
  });
  await page.exposeFunction("reportDemoScene", (index, title) => {
    process.stdout.write(
      `${JSON.stringify({ type: "demo-recording-scene", scene: index + 1, total: scenes.length, title })}\n`,
    );
  });
  await page.setContent(
    '<!doctype html><html><body style="margin:0;background:#09131f"><canvas id="recording" width="1280" height="720"></canvas></body></html>',
  );
  const encodedScenes = await Promise.all(
    scenes.map(async ({ imagePath, ...scene }) => ({
      ...scene,
      image: `data:image/png;base64,${(await readFile(imagePath)).toString("base64")}`,
    })),
  );
  const result = await page.evaluate(
    async ({ frames, frameDurationMs }) => {
      const canvas = document.querySelector("#recording");
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Recording canvas is missing");
      const drawing = canvas.getContext("2d");
      if (drawing === null) throw new Error("2D canvas is unavailable");
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(
        (candidate) => MediaRecorder.isTypeSupported(candidate),
      );
      if (mimeType === undefined) throw new Error("This browser cannot encode WebM");
      const images = await Promise.all(
        frames.map(
          (frame) =>
            new Promise((resolveImage, rejectImage) => {
              const image = new Image();
              image.onload = () => resolveImage(image);
              image.onerror = () => rejectImage(new Error("A demo screenshot could not be loaded"));
              image.src = frame.image;
            }),
        ),
      );
      const wrap = (text, x, y, maxWidth, lineHeight) => {
        const words = text.split(" ");
        let line = "";
        let row = 0;
        for (const word of words) {
          const candidate = line === "" ? word : `${line} ${word}`;
          if (drawing.measureText(candidate).width <= maxWidth) {
            line = candidate;
            continue;
          }
          drawing.fillText(line, x, y + row * lineHeight);
          line = word;
          row += 1;
        }
        drawing.fillText(line, x, y + row * lineHeight);
      };
      const draw = (frame, image, index, progress) => {
        drawing.fillStyle = "#09131f";
        drawing.fillRect(0, 0, 1280, 720);
        drawing.drawImage(image, 0, 0, 1280, 720);
        const gradient = drawing.createLinearGradient(0, 350, 0, 720);
        gradient.addColorStop(0, "rgba(5, 14, 24, 0)");
        gradient.addColorStop(0.52, "rgba(5, 14, 24, 0.84)");
        gradient.addColorStop(1, "rgba(5, 14, 24, 0.98)");
        drawing.fillStyle = gradient;
        drawing.fillRect(0, 350, 1280, 370);
        drawing.fillStyle = "rgba(9, 35, 49, 0.92)";
        drawing.fillRect(42, 38, 270, 40);
        drawing.fillStyle = "#76d8df";
        drawing.font = "700 18px Segoe UI, sans-serif";
        drawing.fillText(`DEVDOCK DEMO  ${index + 1}/${frames.length}`, 60, 65);
        drawing.fillStyle = "#75cbd4";
        drawing.font = "700 18px Segoe UI, sans-serif";
        drawing.fillText(frame.eyebrow.toUpperCase(), 60, 506);
        drawing.fillStyle = "#f2f7fb";
        drawing.font = "700 38px Segoe UI, sans-serif";
        drawing.fillText(frame.title, 60, 555);
        drawing.fillStyle = "#c8d8e7";
        drawing.font = "400 21px Segoe UI, sans-serif";
        wrap(frame.body, 60, 592, 1160, 30);
        drawing.fillStyle = "rgba(117, 203, 212, 0.25)";
        drawing.fillRect(60, 691, 1160, 6);
        drawing.fillStyle = "#68d2dc";
        drawing.fillRect(60, 691, 1160 * ((index + progress) / frames.length), 6);
      };
      draw(frames[0], images[0], 0, 0);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 });
      const writes = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        writes.push(
          event.data.arrayBuffer().then(async (arrayBuffer) => {
            const bytes = new Uint8Array(arrayBuffer);
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 32_768) {
              binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
            }
            await window.appendDemoVideoChunk(btoa(binary));
          }),
        );
      };
      const stopped = new Promise((resolveStop, rejectStop) => {
        recorder.onstop = resolveStop;
        recorder.onerror = () => rejectStop(recorder.error ?? new Error("MediaRecorder failed"));
      });
      const startedAt = performance.now();
      recorder.start(1_000);
      for (const [index, frame] of frames.entries()) {
        await window.reportDemoScene(index, frame.title);
        const frameStartedAt = performance.now();
        while (performance.now() - frameStartedAt < frameDurationMs) {
          const progress = Math.min(1, (performance.now() - frameStartedAt) / frameDurationMs);
          draw(frame, images[index], index, progress);
          await new Promise((resolveFrame) => setTimeout(resolveFrame, 100));
        }
      }
      recorder.stop();
      await stopped;
      await Promise.all(writes);
      for (const track of stream.getTracks()) track.stop();
      return { elapsedMs: performance.now() - startedAt, mimeType };
    },
    { frames: encodedScenes, frameDurationMs: sceneMs },
  );
  await page.close();
  if (chunks.length === 0) throw new Error("MediaRecorder produced no video data");
  await writeFile(outputPath, Buffer.concat(chunks));
  return result;
}

async function inspectRecording(context) {
  const page = await context.newPage();
  await page.goto(pathToFileURL(outputPath).href, { waitUntil: "domcontentloaded" });
  const video = page.locator("video");
  await video.waitFor({ state: "attached" });
  const media = await video.evaluate(async (element) => {
    if (!(element instanceof HTMLVideoElement)) throw new Error("Recorded file is not video");
    if (element.readyState < 1) {
      await new Promise((resolveMetadata, rejectMetadata) => {
        element.addEventListener("loadedmetadata", resolveMetadata, { once: true });
        element.addEventListener("error", () => rejectMetadata(element.error), { once: true });
      });
    }
    if (!Number.isFinite(element.duration)) {
      element.currentTime = 1e101;
      await new Promise((resolveSeek) =>
        element.addEventListener("seeked", resolveSeek, { once: true }),
      );
    }
    return {
      durationSeconds: element.duration,
      width: element.videoWidth,
      height: element.videoHeight,
    };
  });
  await page.close();
  return media;
}

async function main() {
  const temporaryRoot = safeTemporaryRoot(await mkdtemp(join(tmpdir(), "devdock-demo-recording-")));
  const sceneDirectory = join(temporaryRoot, "scenes");
  await mkdir(sceneDirectory);
  await mkdir(artifactsDirectory, { recursive: true });

  let generatedProject;
  let store;
  let api;
  let browser;
  let conflict;
  let sentinel;
  let origin;
  let configuration;
  let sentinelPreserved = false;
  let recording;
  let media;
  let completionSummary;
  const cleanupErrors = [];
  const pageErrors = [];
  try {
    configuration = await prepareDemoProject();
    generatedProject = safeGeneratedProject(configuration.projectPath);
    const apiUrl = `http://127.0.0.1:${configuration.apiPort}/ready`;
    const unhealthyUrl = `http://127.0.0.1:${configuration.unhealthyPort}/ready`;
    const sentinelUrl = `http://127.0.0.1:${configuration.sentinelPort}/ready`;

    sentinel = startFixture(generatedProject, "env.sentinel", "sentinel");
    await waitForStatus(sentinelUrl, 200);

    store = await RegistryDatabase.open(join(temporaryRoot, "registry.sqlite"));
    const registry = new ProjectRegistry(store);
    const project = await registry.registerProject(generatedProject, "DevDock Demo");
    const apiService = await registry.selectService(project.id, "api", {
      displayName: "API",
      expectedPort: configuration.apiPort,
      readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
      envFiles: ["env.api"],
    });
    const workerService = await registry.selectService(project.id, "worker", {
      displayName: "Worker",
    });
    await registry.selectService(project.id, "unhealthy", {
      displayName: "Unhealthy API",
      expectedPort: configuration.unhealthyPort,
      readiness: { kind: "http", path: "/ready", timeoutMs: 1_000 },
      envFiles: ["env.unhealthy"],
    });
    await registry.createProfile(project.id, "Full Stack", [
      { serviceId: apiService.id, dependsOn: [] },
      { serviceId: workerService.id, dependsOn: [apiService.id] },
    ]);

    const launcher = await NpmLauncher.locate();
    const runtime = new ServiceRuntimeManager({
      registry,
      launcher,
      adapterFactory: () => createPlatformProcessAdapter(),
      daemonSessionId: "phase-7-demo-recording",
    });
    api = createLocalApiServer({ registry, launcher, runtime, webRoot });
    origin = await api.listen(0);

    browser = await chromium.launch({
      executablePath: await browserExecutable(),
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(origin);
    await page.getByLabel("Pairing code").fill(api.pairingCode);
    await page.getByRole("button", { name: "Pair browser" }).click();
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page.getByRole("button", { name: /DevDock Demo/u }).click();
    await page.getByRole("heading", { name: "DevDock Demo" }).waitFor();

    const apiCard = page.locator("article.service-card").filter({ hasText: "npm run api" });
    const workerCard = page.locator("article.service-card").filter({ hasText: "npm run worker" });
    const unhealthyCard = page
      .locator("article.service-card")
      .filter({ hasText: "npm run unhealthy" });
    const profileCard = page.locator("article.profile-card").filter({ hasText: "Full Stack" });
    await profileCard.getByRole("heading", { name: "Full Stack" }).waitFor();

    const scenes = [];
    scenes.push(
      await captureScene(page, sceneDirectory, "01-overview", "top", {
        eyebrow: "Local dashboard",
        title: "DevDock keeps project control on loopback",
        body: "This recording uses the real dashboard, authenticated API, SQLite registry, and native process adapter.",
      }),
    );
    scenes.push(
      await captureScene(page, sceneDirectory, "02-configuration", profileCard, {
        eyebrow: "Configuration",
        title: "Two services start as one dependency-aware profile",
        body: "Full Stack starts API first, waits for HTTP readiness, then starts the worker. A separate unhealthy service demonstrates failure.",
      }),
    );

    conflict = startFixture(generatedProject, "env.api", "sentinel");
    await waitForStatus(apiUrl, 200);
    await apiCard.getByRole("button", { name: "Run API diagnostics" }).click();
    const diagnostics = apiCard.getByRole("region", { name: "API diagnostics" });
    await diagnostics.getByText("In Use", { exact: false }).waitFor();
    scenes.push(
      await captureScene(page, sceneDirectory, "03-port-conflict", diagnostics, {
        eyebrow: "Diagnostics",
        title: "A port conflict is reported without taking ownership",
        body: "An external listener already owns the API port. DevDock reports In use and leaves that process untouched.",
      }),
    );
    await stopFixture(conflict);
    conflict = undefined;
    await waitForClosed(apiUrl);
    await page.reload();
    await page.getByRole("heading", { name: "Projects" }).waitFor();
    await page.getByRole("button", { name: /DevDock Demo/u }).click();
    await profileCard.getByRole("heading", { name: "Full Stack" }).waitFor();

    await profileCard.getByRole("button", { name: "Start profile" }).click();
    await profileCard.locator(".state-pill").getByText("Ready", { exact: true }).waitFor({
      timeout: 10_000,
    });
    scenes.push(
      await captureScene(page, sceneDirectory, "04-profile-ready", profileCard, {
        eyebrow: "Orchestration",
        title: "Full Stack is ready after dependency-first startup",
        body: "The profile snapshot records both service outcomes and keeps each owned run available for an explicit Stop.",
      }),
    );

    await apiCard.getByRole("button", { name: "Refresh API status" }).click();
    await apiCard.locator(".runtime-facts").getByText("Ready", { exact: true }).waitFor();
    await workerCard.getByRole("button", { name: "Refresh Worker status" }).click();
    await workerCard.locator(".status-chip").getByText("Running", { exact: true }).waitFor();
    await apiCard.getByRole("button", { name: "View runtime" }).click();
    const apiLogs = apiCard.getByRole("list", { name: "API logs" });
    await apiLogs.locator("li").first().waitFor({ timeout: 5_000 });
    scenes.push(
      await captureScene(page, sceneDirectory, "05-api-logs", apiLogs, {
        eyebrow: "Live logs",
        title: "API output streams through the bounded log pipeline",
        body: "Run identity, PID, readiness, ownership, and structured stdout remain separate facts in the dashboard.",
      }),
    );

    await workerCard.getByRole("button", { name: "View runtime" }).click();
    const workerLogs = workerCard.getByRole("list", { name: "Worker logs" });
    await workerLogs.locator("li").first().waitFor({ timeout: 5_000 });
    scenes.push(
      await captureScene(page, sceneDirectory, "06-worker-logs", workerLogs, {
        eyebrow: "Two services",
        title: "Worker logs have their own run and stream",
        body: "Selecting another service closes the previous EventSource while both service processes continue under daemon ownership.",
      }),
    );

    await profileCard.getByRole("button", { name: "Stop profile" }).click();
    await profileCard.locator(".state-pill").getByText("Stopped", { exact: true }).waitFor();
    await waitForClosed(apiUrl);
    sentinelPreserved = (await waitForStatus(sentinelUrl, 200)).status === 200;
    scenes.push(
      await captureScene(page, sceneDirectory, "07-profile-stopped", profileCard, {
        eyebrow: "Ownership",
        title: "Stop closes owned runs and preserves the external sentinel",
        body: "API and Worker stopped. The independently launched sentinel still returned HTTP 200 because DevDock never owned its handle.",
      }),
    );

    await unhealthyCard.getByRole("button", { name: "Start Unhealthy API" }).click();
    await unhealthyCard.locator(".runtime-facts").getByText("Checking", { exact: true }).waitFor({
      timeout: 2_000,
    });
    scenes.push(
      await captureScene(page, sceneDirectory, "08-readiness-checking", unhealthyCard, {
        eyebrow: "Readiness",
        title: "A running process is not automatically ready",
        body: "The process is owned and running while DevDock probes /ready. Process state and readiness state are displayed independently.",
      }),
    );
    await unhealthyCard.locator(".status-chip").getByText("Failed", { exact: true }).waitFor({
      timeout: 5_000,
    });
    await unhealthyCard.locator(".runtime-facts").getByText("Unhealthy", { exact: true }).waitFor();
    await waitForClosed(unhealthyUrl);
    scenes.push(
      await captureScene(page, sceneDirectory, "09-readiness-failed", unhealthyCard, {
        eyebrow: "Failure is explicit",
        title: "Repeated HTTP 503 ends as failed and unhealthy",
        body: "The timeout records the reason, stops the owned process tree, and releases the port instead of claiming success from a live PID.",
      }),
    );
    scenes.push(
      await captureScene(page, sceneDirectory, "10-summary", "top", {
        eyebrow: "DevDock v1",
        title: "One local control plane with bounded observability",
        body: "The same service contract runs on verified Windows, macOS, and Linux adapters, with conservative ownership and reproducible diagnostics.",
      }),
    );

    assert.deepEqual(pageErrors, []);
    await page.close();
    const expectedDurationMs = scenes.length * sceneMs;
    if (durationOverride === undefined) {
      assert.ok(expectedDurationMs >= 180_000 && expectedDurationMs <= 300_000);
    }
    recording = await renderRecording(context, scenes);
    media = await inspectRecording(context);
    const output = await stat(outputPath);
    assert.ok(output.size > 100_000, "Recorded video is unexpectedly small");
    assert.equal(media.width, 1280);
    assert.equal(media.height, 720);
    assert.ok(
      media.durationSeconds * 1_000 >= expectedDurationMs - 3_000 &&
        media.durationSeconds * 1_000 <= expectedDurationMs + 10_000,
      `Recorded duration ${media.durationSeconds}s did not match ${expectedDurationMs / 1_000}s`,
    );

    const report = {
      recordedAt: new Date().toISOString(),
      outputPath,
      mimeType: recording.mimeType,
      sceneCount: scenes.length,
      sceneDurationMs: sceneMs,
      measuredWallDurationMs: Math.round(recording.elapsedMs),
      mediaDurationSeconds: media.durationSeconds,
      dimensions: { width: media.width, height: media.height },
      fileBytes: output.size,
      evidence: {
        realDashboard: true,
        portConflictObserved: true,
        profileReachedReady: true,
        apiLogsObserved: true,
        workerLogsObserved: true,
        sentinelPreservedAfterProfileStop: sentinelPreserved,
        readinessFailureObserved: true,
      },
      privacy: {
        pairingCodeCaptured: false,
        desktopCaptured: false,
        unrelatedApplicationsCaptured: false,
      },
      publication: "local-only",
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    completionSummary = {
      type: "demo-recording-complete",
      outputPath,
      reportPath,
      durationSeconds: media.durationSeconds,
      fileBytes: output.size,
      sentinelPreserved,
    };
  } finally {
    const cleanup = async (operation) => {
      try {
        await operation;
      } catch (caught) {
        cleanupErrors.push(caught);
      }
    };
    await cleanup(stopFixture(conflict));
    await cleanup(api?.close());
    try {
      store?.close();
    } catch (caught) {
      cleanupErrors.push(caught);
    }
    await cleanup(stopFixture(sentinel));
    if (configuration !== undefined) {
      await Promise.all([
        cleanup(waitForClosed(`http://127.0.0.1:${configuration.apiPort}/ready`)),
        cleanup(waitForClosed(`http://127.0.0.1:${configuration.unhealthyPort}/ready`)),
        cleanup(waitForClosed(`http://127.0.0.1:${configuration.sentinelPort}/ready`)),
      ]);
    }
    await cleanup(browser?.close());
    if (generatedProject !== undefined) {
      await cleanup(
        rm(generatedProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      );
    }
    await cleanup(
      rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Demo recording cleanup did not complete");
  }
  assert.ok(completionSummary !== undefined);
  process.stdout.write(`${JSON.stringify(completionSummary)}\n`);
}

main().catch((caught) => {
  process.stderr.write(`${caught instanceof Error ? caught.stack : "Demo recording failed"}\n`);
  process.exitCode = 1;
});
