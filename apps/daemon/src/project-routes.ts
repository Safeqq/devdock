import { execFile } from "node:child_process";
import {
  CreateProfileRequestSchema,
  FolderInspectionRequestSchema,
  FolderInspectionResponseSchema,
  ProfileRuntimeStatusResponseSchema,
  ProfileStartResponseSchema,
  ProfileStopResponseSchema,
  ProjectConfigurationExportSchema,
  RegisterProjectRequestSchema,
  RegistryIdSchema,
  RuntimeSummaryResponseSchema,
  SelectServiceRequestSchema,
  ServiceActionRequestSchema,
  ServiceDiagnosticsResponseSchema,
  ServiceRuntimeStatusResponseSchema,
  ServiceStartResponseSchema,
  ServiceStopResponseSchema,
  type SystemInfo,
  SystemInfoResponseSchema,
  UpdateServiceSettingsRequestSchema,
} from "@devdock/contracts";
import type { NpmLauncher } from "@devdock/platform";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProfileRuntimeManager } from "./profile-runtime-manager.js";
import type { ProjectRegistry } from "./project-registry.js";
import type { ServiceRuntimeManager } from "./service-runtime-manager.js";

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "REQUEST_INVALID", message: "Request data is invalid" },
  });
}

function lifecycleUnavailable(reply: FastifyReply) {
  return reply.code(501).send({
    error: {
      code: "SERVICE_CONTROL_UNAVAILABLE",
      message: "Service control is unavailable on this platform",
    },
  });
}

// Asks the Node.js that runs projects for its version once; DevDock shows it so users know which
// installation their scripts use.
function nodeVersion(launcher: NpmLauncher): Promise<string | null> {
  if (launcher.nodeSource === "daemon") return Promise.resolve(process.version);
  return new Promise((resolve) => {
    execFile(
      launcher.nodeExecutable,
      ["--version"],
      { timeout: 5_000, windowsHide: true, maxBuffer: 1_024 },
      (error, stdout) => {
        const version = String(stdout).trim();
        resolve(error === null && /^v\d+\.\d+\.\d+/u.test(version) ? version.slice(0, 64) : null);
      },
    );
  });
}

function idFrom(params: unknown): string | null {
  if (params === null || typeof params !== "object" || !("id" in params)) return null;
  const parsed = RegistryIdSchema.safeParse(params.id);
  return parsed.success ? parsed.data : null;
}

export function registerProjectRoutes(
  app: FastifyInstance,
  registry: ProjectRegistry,
  launcher: NpmLauncher,
  runtime?: ServiceRuntimeManager,
  profileRuntime?: ProfileRuntimeManager,
): void {
  let systemInfo: Promise<SystemInfo> | undefined;

  // The current run's printed address, so Open App can use what the app really listens on.
  async function currentAppUrl(serviceId: string): Promise<string | null> {
    if (runtime === undefined) return null;
    const { snapshot } = await runtime.status(serviceId);
    if (
      snapshot === null ||
      (snapshot.processState !== "starting" && snapshot.processState !== "running")
    ) {
      return null;
    }
    return runtime.appUrl(snapshot.runId);
  }

  app.get("/api/system", async () => {
    systemInfo ??= nodeVersion(launcher).then((version) =>
      SystemInfoResponseSchema.parse({ projectNode: { source: launcher.nodeSource, version } }),
    );
    return systemInfo;
  });

  app.get("/api/runtime/summary", async () => {
    const projects = [];
    for (const project of registry.listProjects()) {
      let active = 0;
      let failed = 0;
      if (runtime !== undefined) {
        for (const service of registry.listServices(project.id)) {
          const { snapshot } = await runtime.status(service.id);
          if (snapshot === null) continue;
          if (
            snapshot.reconciliationState === "known" &&
            (snapshot.processState === "starting" ||
              snapshot.processState === "running" ||
              snapshot.processState === "stopping")
          ) {
            active += 1;
          } else if (snapshot.processState === "failed") {
            failed += 1;
          }
        }
      }
      projects.push({ projectId: project.id, active, failed });
    }
    return RuntimeSummaryResponseSchema.parse({ projects });
  });

  app.post("/api/folders/inspect", async (request, reply) => {
    const parsed = FolderInspectionRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    return FolderInspectionResponseSchema.parse(await registry.inspectFolder(parsed.data.path));
  });

  app.get("/api/projects", async () => ({ projects: registry.listProjects() }));

  app.post("/api/projects", async (request, reply) => {
    const parsed = RegisterProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const project = await registry.registerProject(parsed.data.path, parsed.data.displayName);
    return reply.code(201).send({ project });
  });

  app.get("/api/projects/:id", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    return {
      project: registry.getProject(id),
      services: registry.listServices(id),
      profiles: registry.listProfiles(id),
    };
  });

  app.get("/api/projects/:id/export", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const configuration = ProjectConfigurationExportSchema.parse(
      registry.exportProjectConfiguration(id),
    );
    return reply
      .header("content-disposition", 'attachment; filename="devdock-configuration.json"')
      .send(configuration);
  });

  app.post("/api/projects/:id/archive", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    if (runtime !== undefined) {
      for (const service of registry.listServices(id)) {
        const { snapshot } = await runtime.status(service.id);
        if (
          snapshot !== null &&
          (snapshot.reconciliationState === "unknown" ||
            snapshot.processState === "starting" ||
            snapshot.processState === "running" ||
            snapshot.processState === "stopping")
        ) {
          return reply.code(409).send({
            error: {
              code: "PROJECT_HAS_ACTIVE_SERVICES",
              message: "Stop or reconcile project services before archiving",
            },
          });
        }
      }
    }
    if (profileRuntime !== undefined) {
      for (const profile of registry.listProfiles(id)) {
        const { snapshot } = await profileRuntime.status(profile.id);
        if (
          snapshot !== null &&
          (snapshot.state === "starting" ||
            snapshot.state === "ready" ||
            snapshot.state === "stopping")
        ) {
          return reply.code(409).send({
            error: {
              code: "PROJECT_HAS_ACTIVE_PROFILES",
              message: "Stop project profiles before archiving",
            },
          });
        }
      }
    }
    return { project: registry.archiveProject(id) };
  });

  app.get("/api/projects/:id/scripts", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const query = request.query;
    if (query === null || typeof query !== "object") return invalid(reply);
    const cwd = "cwd" in query ? query.cwd : undefined;
    if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4_096)) {
      return invalid(reply);
    }
    return { discovery: await registry.discoverScripts(id, cwd) };
  });

  app.post("/api/projects/:id/services", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const parsed = SelectServiceRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const service = await registry.selectService(id, parsed.data.scriptName, {
      ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
      ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      ...(parsed.data.expectedPort === undefined ? {} : { expectedPort: parsed.data.expectedPort }),
      ...(parsed.data.readiness === undefined ? {} : { readiness: parsed.data.readiness }),
      restartPolicy: parsed.data.restartPolicy,
      envFiles: parsed.data.envFiles,
      requiredEnvKeys: parsed.data.requiredEnvKeys,
    });
    return reply.code(201).send({ service });
  });

  app.post("/api/services/:id/settings", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const parsed = UpdateServiceSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const service = await registry.updateServiceSettings(id, {
      ...(parsed.data.expectedPort === undefined ? {} : { expectedPort: parsed.data.expectedPort }),
      ...(parsed.data.readiness === undefined ? {} : { readiness: parsed.data.readiness }),
      restartPolicy: parsed.data.restartPolicy,
      envFiles: parsed.data.envFiles,
      requiredEnvKeys: parsed.data.requiredEnvKeys,
    });
    return { service };
  });

  app.post("/api/projects/:id/profiles", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const parsed = CreateProfileRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const profile = await registry.createProfile(id, parsed.data.displayName, parsed.data.services);
    return reply.code(201).send({ profile });
  });

  app.get("/api/services/:id/preview", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    const plan = await registry.launchPlan(id, launcher);
    return {
      command: {
        executable: plan.executable,
        args: plan.args,
        cwd: plan.canonicalCwd,
      },
    };
  });

  app.get("/api/services/:id/open-app", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    return { url: await registry.openAppUrl(id, await currentAppUrl(id)) };
  });

  app.get("/api/services/:id/diagnostics", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    return ServiceDiagnosticsResponseSchema.parse(await registry.diagnostics(id, launcher));
  });

  app.get("/api/services/:id/status", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    if (runtime === undefined) return lifecycleUnavailable(reply);
    const inspection = await runtime.status(id);
    return ServiceRuntimeStatusResponseSchema.parse({
      ...inspection,
      appUrl: inspection.snapshot === null ? null : runtime.appUrl(inspection.snapshot.runId),
    });
  });

  app.post("/api/services/:id/start", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null || !ServiceActionRequestSchema.safeParse(request.body).success) {
      return invalid(reply);
    }
    if (runtime === undefined) return lifecycleUnavailable(reply);
    const response = ServiceStartResponseSchema.parse({ outcome: await runtime.start(id) });
    const status =
      response.outcome.kind === "started"
        ? 202
        : response.outcome.kind === "existing"
          ? 200
          : response.outcome.kind === "rejected"
            ? 409
            : 500;
    return reply.code(status).send(response);
  });

  app.post("/api/services/:id/stop", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null || !ServiceActionRequestSchema.safeParse(request.body).success) {
      return invalid(reply);
    }
    if (runtime === undefined) return lifecycleUnavailable(reply);
    const response = ServiceStopResponseSchema.parse({ outcome: await runtime.stop(id) });
    return reply.code(response.outcome.kind === "incomplete" ? 409 : 200).send(response);
  });

  app.get("/api/profiles/:id/status", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    if (profileRuntime === undefined) return lifecycleUnavailable(reply);
    return ProfileRuntimeStatusResponseSchema.parse(await profileRuntime.status(id));
  });

  app.post("/api/profiles/:id/start", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null || !ServiceActionRequestSchema.safeParse(request.body).success) {
      return invalid(reply);
    }
    if (profileRuntime === undefined) return lifecycleUnavailable(reply);
    const response = ProfileStartResponseSchema.parse({ outcome: await profileRuntime.start(id) });
    return reply.code(response.outcome.kind === "started" ? 202 : 200).send(response);
  });

  app.post("/api/profiles/:id/stop", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null || !ServiceActionRequestSchema.safeParse(request.body).success) {
      return invalid(reply);
    }
    if (profileRuntime === undefined) return lifecycleUnavailable(reply);
    return ProfileStopResponseSchema.parse({ outcome: await profileRuntime.stop(id) });
  });
}
