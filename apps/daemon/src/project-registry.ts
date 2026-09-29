import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  NpmScriptNameSchema,
  type ProjectRecord,
  type RunSnapshot,
  type ScriptDiscovery,
  ScriptDiscoverySchema,
  type ServiceConfig,
  ServiceConfigSchema,
} from "@devdock/contracts";
import type { NpmLauncher, SpawnRequest } from "@devdock/platform";
import { discoverPackageScripts, resolveProjectDirectory } from "@devdock/platform";
import type { RegistryDatabase } from "@devdock/storage";

export class ProjectRegistryError extends Error {
  constructor(
    readonly code:
      | "PROJECT_NOT_FOUND"
      | "PROJECT_ARCHIVED"
      | "PROJECT_IDENTITY_CHANGED"
      | "PROJECT_NAME_INVALID"
      | "SCRIPT_NOT_FOUND"
      | "SCRIPT_NAME_INVALID"
      | "SERVICE_CONFIG_INVALID"
      | "SERVICE_NOT_FOUND"
      | "OPEN_APP_PORT_UNCONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

export class ProjectRegistry {
  readonly #store: RegistryDatabase;

  constructor(store: RegistryDatabase) {
    this.#store = store;
  }

  async registerProject(path: string, name?: string): Promise<ProjectRecord> {
    const resolved = await resolveProjectDirectory(path);
    const displayName = (
      name ??
      (basename(resolved.canonicalPath) || resolved.canonicalPath)
    ).trim();
    if (displayName.length === 0 || displayName.length > 128) {
      throw new ProjectRegistryError(
        "PROJECT_NAME_INVALID",
        "Project name must be 1–128 characters",
      );
    }
    return this.#store.registerProject({
      displayName,
      displayPath: resolved.displayPath,
      canonicalPath: resolved.canonicalPath,
      identityKey: resolved.identityKey,
    });
  }

  archiveProject(id: string): ProjectRecord {
    const project = this.#store.archiveProject(id);
    if (project === null) {
      throw new ProjectRegistryError("PROJECT_NOT_FOUND", "Project does not exist");
    }
    return project;
  }

  listProjects(includeArchived = false): ProjectRecord[] {
    return this.#store.listProjects(includeArchived);
  }

  getProject(id: string): ProjectRecord {
    const project = this.#store.getProject(id);
    if (project === null) {
      throw new ProjectRegistryError("PROJECT_NOT_FOUND", "Project does not exist");
    }
    return project;
  }

  listServices(projectId: string): ServiceConfig[] {
    this.getProject(projectId);
    return this.#store.listServices(projectId);
  }

  getService(id: string): ServiceConfig {
    const service = this.#store.getService(id);
    if (service === null) {
      throw new ProjectRegistryError("SERVICE_NOT_FOUND", "Service does not exist");
    }
    return service;
  }

  saveRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
    this.getService(snapshot.serviceId);
    return this.#store.saveRunSnapshot(snapshot);
  }

  latestRun(serviceId: string): RunSnapshot | null {
    this.getService(serviceId);
    return this.#store.listRuns(serviceId).at(-1) ?? null;
  }

  async #activeProject(id: string): Promise<ProjectRecord> {
    const project = this.#store.getProject(id);
    if (project === null) {
      throw new ProjectRegistryError("PROJECT_NOT_FOUND", "Project does not exist");
    }
    if (project.archivedAt !== undefined) {
      throw new ProjectRegistryError("PROJECT_ARCHIVED", "Project is archived");
    }
    const current = await resolveProjectDirectory(project.path.displayPath);
    const storedIdentity = this.#store.getProjectIdentityKey(id);
    if (
      current.canonicalPath !== project.path.canonicalPath ||
      (storedIdentity !== null && current.identityKey !== storedIdentity)
    ) {
      throw new ProjectRegistryError(
        "PROJECT_IDENTITY_CHANGED",
        "Project directory identity has changed",
      );
    }
    return project;
  }

  async discoverScripts(projectId: string, cwd = "."): Promise<ScriptDiscovery> {
    const project = await this.#activeProject(projectId);
    const discovered = await discoverPackageScripts(project.path, cwd);
    const supported = discovered.scriptNames.filter(
      (name) => NpmScriptNameSchema.safeParse(name).success,
    );
    return ScriptDiscoverySchema.parse({
      cwd: discovered.cwd,
      ...(discovered.packageName === undefined || discovered.packageName.length > 214
        ? {}
        : { packageName: discovered.packageName }),
      scriptNames: supported,
      unsupportedScriptCount: discovered.scriptNames.length - supported.length,
    });
  }

  async selectService(
    projectId: string,
    scriptName: string,
    options: { cwd?: string; displayName?: string; expectedPort?: number } = {},
  ): Promise<ServiceConfig> {
    if (!NpmScriptNameSchema.safeParse(scriptName).success) {
      throw new ProjectRegistryError("SCRIPT_NAME_INVALID", "Selected npm script name is invalid");
    }
    const discovery = await this.discoverScripts(projectId, options.cwd);
    if (!discovery.scriptNames.includes(scriptName)) {
      throw new ProjectRegistryError(
        "SCRIPT_NOT_FOUND",
        "Selected npm script is not in package.json",
      );
    }
    const parsed = ServiceConfigSchema.safeParse({
      id: randomUUID(),
      projectId,
      displayName: options.displayName ?? scriptName,
      scriptName,
      cwd: discovery.cwd,
      ...(options.expectedPort === undefined ? {} : { expectedPort: options.expectedPort }),
      envFiles: [],
    });
    if (!parsed.success) {
      throw new ProjectRegistryError("SERVICE_CONFIG_INVALID", "Service configuration is invalid");
    }
    return this.#store.insertService(parsed.data);
  }

  async openAppUrl(serviceId: string): Promise<string> {
    const service = this.getService(serviceId);
    await this.#activeProject(service.projectId);
    if (service.expectedPort === undefined) {
      throw new ProjectRegistryError(
        "OPEN_APP_PORT_UNCONFIGURED",
        "Service has no configured app port",
      );
    }
    return `http://127.0.0.1:${service.expectedPort}/`;
  }

  async launchPlan(serviceId: string, launcher: NpmLauncher): Promise<Omit<SpawnRequest, "runId">> {
    const service = this.getService(serviceId);
    const discovery = await this.discoverScripts(service.projectId, service.cwd.displayPath);
    if (discovery.cwd.canonicalPath !== service.cwd.canonicalPath) {
      throw new ProjectRegistryError(
        "PROJECT_IDENTITY_CHANGED",
        "Service cwd identity has changed",
      );
    }
    if (!discovery.scriptNames.includes(service.scriptName)) {
      throw new ProjectRegistryError(
        "SCRIPT_NOT_FOUND",
        "Selected npm script is no longer in package.json",
      );
    }
    return launcher.plan(service.scriptName, discovery.cwd.canonicalPath);
  }
}
