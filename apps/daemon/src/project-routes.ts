import {
  RegisterProjectRequestSchema,
  RegistryIdSchema,
  SelectServiceRequestSchema,
} from "@devdock/contracts";
import type { NpmLauncher } from "@devdock/platform";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProjectRegistry } from "./project-registry.js";

function invalid(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "REQUEST_INVALID", message: "Request data is invalid" },
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
}
