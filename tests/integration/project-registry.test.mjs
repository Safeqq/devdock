import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ProjectRegistry } from "../../apps/daemon/dist/project-registry.js";
import { NpmLauncher } from "../../packages/platform/dist/index.js";
import { RegistryDatabase } from "../../packages/storage/dist/index.js";
import { migrations } from "../../packages/storage/dist/migrations.js";

async function runPlan(plan) {
  const child = spawn(plan.executable, [...plan.args], {
    cwd: plan.canonicalCwd,
    env: plan.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_096);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("npm script did not exit before timeout"));
    }, 8_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm script exited with code ${code}: ${stderr}`));
    });
  });
}

test("project registry persists selections without running scripts during discovery", {
  timeout: 20_000,
}, async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-phase2-"));
  const projectPath = join(tempRoot, "project café & [app] (x)");
  const outsidePath = join(tempRoot, "outside");
  const markerPath = join(projectPath, "marker.out");
  const dbPath = join(tempRoot, "data", "devdock.sqlite");
  let store;
  try {
    await mkdir(projectPath);
    await mkdir(outsidePath);
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "phase2-fixture", scripts: { "mark:ready": "node ./marker.mjs" } }),
    );
    await writeFile(
      join(projectPath, "marker.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./marker.out', import.meta.url), process.env.PROJECT_TOKEN ?? 'missing');",
    );
    await writeFile(join(projectPath, ".env.test"), "PROJECT_TOKEN=loaded-from-env-file\n");

    store = await RegistryDatabase.open(dbPath);
    assert.equal(store.schemaVersion(), 2);
    const registry = new ProjectRegistry(store);
    const project = await registry.registerProject(projectPath);
    const duplicate = await registry.registerProject(join(projectPath, "."));
    assert.equal(duplicate.id, project.id);
    const projectAlias = join(tempRoot, "project-alias");
    await symlink(projectPath, projectAlias, process.platform === "win32" ? "junction" : "dir");
    const aliased = await registry.registerProject(projectAlias);
    assert.equal(aliased.id, project.id);
    const escapingDirectory = join(projectPath, "outside-link");
    await symlink(
      outsidePath,
      escapingDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(registry.discoverScripts(project.id, "outside-link"), {
      code: "CWD_OUTSIDE_PROJECT",
    });
    assert.equal(registry.listProjects().length, 1);

    const discovered = await registry.discoverScripts(project.id);
    assert.deepEqual(discovered.scriptNames, ["mark:ready"]);
    assert.equal(discovered.unsupportedScriptCount, 0);
    assert.equal(discovered.packageName, "phase2-fixture");
    const service = await registry.selectService(project.id, "mark:ready", {
      envFiles: [".env.test"],
      requiredEnvKeys: ["PROJECT_TOKEN"],
    });
    const secondary = await registry.selectService(project.id, "mark:ready", {
      displayName: "Secondary",
    });
    const backendProfile = await registry.createProfile(project.id, "Backend Only", [
      { serviceId: service.id, dependsOn: [] },
    ]);
    await assert.rejects(
      registry.createProfile(project.id, "Cycle", [
        { serviceId: service.id, dependsOn: [secondary.id] },
        { serviceId: secondary.id, dependsOn: [service.id] },
      ]),
      (caught) => {
        assert.equal(caught.code, "PROFILE_CYCLE");
        assert.match(caught.message, /mark:ready -> Secondary -> mark:ready/u);
        return true;
      },
    );
    await assert.rejects(access(markerPath));
    await assert.rejects(registry.selectService(project.id, "missing"), {
      code: "SCRIPT_NOT_FOUND",
    });
    await assert.rejects(registry.discoverScripts(project.id, "../outside"), {
      code: "CWD_OUTSIDE_PROJECT",
    });
    await assert.rejects(
      registry.selectService(project.id, "mark:ready", { envFiles: ["../outside.env"] }),
      { code: "SERVICE_CONFIG_INVALID" },
    );

    const launcher = await NpmLauncher.locate();
    const plan = await registry.launchPlan(service.id, launcher);
    assert.equal(plan.executable, process.execPath);
    assert.equal(plan.args.at(-2), "run");
    assert.equal(plan.args.at(-1), "mark:ready");
    assert.equal(plan.canonicalCwd, project.path.canonicalPath);
    assert.equal(plan.env.PROJECT_TOKEN, "loaded-from-env-file");
    const casingPlan = launcher.plan(
      "mark:ready",
      project.path.canonicalPath,
      process.platform === "win32"
        ? { Path: "C:\\portable-path", PATH: "C:\\wrong-case", SYSTEMROOT: "C:\\Windows" }
        : { PATH: "/portable-path", Path: "/wrong-case" },
    );
    if (process.platform === "win32") {
      assert.equal(casingPlan.env.Path.endsWith(";C:\\portable-path"), true);
      assert.equal(Object.hasOwn(casingPlan.env, "PATH"), false);
      assert.equal(casingPlan.env.SystemRoot, "C:\\Windows");
      assert.equal(Object.hasOwn(casingPlan.env, "SYSTEMROOT"), false);
    } else {
      assert.equal(casingPlan.env.PATH.endsWith(":/portable-path"), true);
      assert.equal(Object.hasOwn(casingPlan.env, "Path"), false);
    }
    assert.equal(
      launcher.plan("mark:ready", plan.canonicalCwd, {
        PATH: process.env.PATH,
        DAEMON_SECRET: "do-not-inherit",
      }).env.DAEMON_SECRET,
      undefined,
    );
    await runPlan(plan);
    assert.equal(await readFile(markerPath, "utf8"), "loaded-from-env-file");

    const missingEnvironment = await registry.selectService(project.id, "mark:ready", {
      displayName: "Missing environment",
      requiredEnvKeys: ["MISSING_PROJECT_TOKEN"],
    });
    await assert.rejects(registry.launchPlan(missingEnvironment.id, launcher), {
      code: "SERVICE_ENV_KEY_MISSING",
    });
    const missingFile = await registry.selectService(project.id, "mark:ready", {
      displayName: "Missing environment file",
      envFiles: [".env.missing"],
    });
    await assert.rejects(registry.launchPlan(missingFile.id, launcher), {
      code: "SERVICE_ENV_FILE_UNAVAILABLE",
    });

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    store.saveRunSnapshot({
      runId,
      serviceId: service.id,
      processState: "exited",
      readinessState: "unknown",
      reconciliationState: "known",
      startedAt,
      endedAt: startedAt,
      exitCode: 0,
    });
    store.saveSettings({ theme: "dark", logLineLimit: 1_000 });
    const archived = registry.archiveProject(project.id);
    assert.ok(archived.archivedAt);
    assert.deepEqual(registry.listProjects(), []);
    await assert.rejects(registry.launchPlan(service.id, launcher), { code: "PROJECT_ARCHIVED" });
    assert.equal(
      await readFile(join(projectPath, "package.json"), "utf8")
        .then(JSON.parse)
        .then((value) => value.name),
      "phase2-fixture",
    );
    store.close();
    store = await RegistryDatabase.open(dbPath);
    assert.equal(store.schemaVersion(), 2);
    assert.equal(store.getProject(project.id).archivedAt, archived.archivedAt);
    assert.equal(store.getService(service.id).scriptName, "mark:ready");
    assert.deepEqual(store.getService(service.id).envFiles, [".env.test"]);
    assert.deepEqual(store.getService(service.id).requiredEnvKeys, ["PROJECT_TOKEN"]);
    assert.deepEqual(store.getService(service.id).restartPolicy, { kind: "off" });
    assert.deepEqual(store.getProfile(backendProfile.id), backendProfile);
    assert.deepEqual(store.listProfiles(project.id), [backendProfile]);
    assert.equal(store.listRuns(service.id)[0].runId, runId);
    assert.deepEqual(store.getSettings(), { theme: "dark", logLineLimit: 1_000 });
    const restored = await new ProjectRegistry(store).registerProject(projectPath);
    assert.equal(restored.id, project.id);
    assert.equal(restored.archivedAt, undefined);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("invalid package JSON is reported without executing its script", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-malformed-"));
  const markerPath = join(tempRoot, "marker.out");
  let store;
  try {
    await writeFile(join(tempRoot, "package.json"), '{"scripts":{"bad":"node marker.mjs",}');
    await writeFile(
      join(tempRoot, "marker.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('marker.out', 'executed');",
    );
    store = await RegistryDatabase.open(":memory:");
    const registry = new ProjectRegistry(store);
    const project = await registry.registerProject(tempRoot);
    await assert.rejects(registry.discoverScripts(project.id), { code: "PACKAGE_JSON_INVALID" });
    await assert.rejects(access(markerPath));
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("newer SQLite schema is rejected before migrations run", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-schema-"));
  const dbPath = join(tempRoot, "future.sqlite");
  try {
    const future = new DatabaseSync(dbPath);
    future.exec("PRAGMA user_version = 99");
    future.close();
    await assert.rejects(RegistryDatabase.open(dbPath), { code: "MIGRATION_NEWER_VERSION" });
    const unchanged = new DatabaseSync(dbPath);
    assert.equal(unchanged.prepare("PRAGMA user_version").get().user_version, 99);
    unchanged.close();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("schema version 1 migrates to profile storage without replacing existing tables", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "devdock-schema-profile-"));
  const dbPath = join(tempRoot, "legacy.sqlite");
  let store;
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(migrations[0].sql);
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    store = await RegistryDatabase.open(dbPath);
    assert.equal(store.schemaVersion(), 2);
    assert.deepEqual(store.listProjects(), []);
  } finally {
    store?.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
