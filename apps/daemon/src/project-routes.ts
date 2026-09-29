import {
  RegisterProjectRequestSchema,
  RegistryIdSchema,
  SelectServiceRequestSchema,
  ServiceActionRequestSchema,
  ServiceRuntimeStatusResponseSchema,
  ServiceStartResponseSchema,
  ServiceStopResponseSchema,
} from "@devdock/contracts";
import type { NpmLauncher } from "@devdock/platform";
import type { FastifyInstance, FastifyReply } from "fastify";
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
): void {
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
    };
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
    });
    return reply.code(201).send({ service });
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
    return { url: await registry.openAppUrl(id) };
  });

  app.get("/api/services/:id/status", async (request, reply) => {
    const id = idFrom(request.params);
    if (id === null) return invalid(reply);
    if (runtime === undefined) return lifecycleUnavailable(reply);
    return ServiceRuntimeStatusResponseSchema.parse(await runtime.status(id));
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
}
