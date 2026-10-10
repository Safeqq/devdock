import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type AppSettings,
  AppSettingsSchema,
  type ProfileConfig,
  ProfileConfigSchema,
  type ProjectRecord,
  ProjectRecordSchema,
  type RunSnapshot,
  RunSnapshotSchema,
  type ServiceConfig,
  ServiceConfigSchema,
} from "@devdock/contracts";
import { migrations } from "./migrations.js";

type BoundValue = string | number | null;

export class RegistryStorageError extends Error {
  constructor(
    readonly code: "DATA_INVALID" | "MIGRATION_NEWER_VERSION" | "PROJECT_IDENTITY_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "RegistryStorageError";
  }
}

interface StoredProject {
  project: ProjectRecord;
  identityKey: string | null;
}

export interface ProjectRegistration {
  displayName: string;
  displayPath: string;
  canonicalPath: string;
  identityKey: string | null;
}

function one(db: DatabaseSync, sql: string, ...values: BoundValue[]) {
  return db.prepare(sql).get(...values);
}

function all(db: DatabaseSync, sql: string, ...values: BoundValue[]) {
  return db.prepare(sql).all(...values);
}

function run(db: DatabaseSync, sql: string, ...values: BoundValue[]) {
  return db.prepare(sql).run(...values);
}

function readJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    throw new RegistryStorageError("DATA_INVALID", `Stored ${label} is invalid`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new RegistryStorageError("DATA_INVALID", `Stored ${label} is invalid`);
  }
}

function projectFromRow(row: Record<string, unknown> | undefined): StoredProject | null {
  if (row === undefined) return null;
  try {
    const project = ProjectRecordSchema.parse({
      id: row.id,
      displayName: row.display_name,
      path: { displayPath: row.display_path, canonicalPath: row.canonical_path },
      createdAt: row.created_at,
      ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    });
    if (row.identity_key !== null && typeof row.identity_key !== "string") {
      throw new Error("Invalid project identity");
    }
    return { project, identityKey: row.identity_key };
  } catch {
    throw new RegistryStorageError("DATA_INVALID", "Stored project is invalid");
  }
}

function migrate(db: DatabaseSync): void {
  const versionRow = one(db, "PRAGMA user_version");
  const currentVersion = versionRow?.user_version;
  if (typeof currentVersion !== "number" || !Number.isSafeInteger(currentVersion)) {
    throw new RegistryStorageError("DATA_INVALID", "SQLite schema version is invalid");
  }
  if (currentVersion > migrations.length) {
    throw new RegistryStorageError(
      "MIGRATION_NEWER_VERSION",
      "Database was created by a newer DevDock version",
    );
  }
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class InstanceLockError extends Error {
  readonly code = "INSTANCE_LOCKED";

  constructor(message: string) {
    super(message);
    this.name = "InstanceLockError";
  }
}

function isSqliteBusy(caught: unknown): boolean {
  if (caught === null || typeof caught !== "object" || !("errcode" in caught)) return false;
  // SQLITE_BUSY (5) or SQLITE_LOCKED (6): another connection holds the lock.
  return caught.errcode === 5 || caught.errcode === 6;
}

// Holds an exclusive SQLite file lock for as long as the daemon runs, so only one DevDock
// instance manages a data directory. The operating system releases the lock when the process
// exits for any reason, so a crash cannot leave a stale lock behind.
export class InstanceLock {
  #db: DatabaseSync | undefined;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async acquire(path: string): Promise<InstanceLock> {
    const lockPath = resolve(path);
    await mkdir(dirname(lockPath), { recursive: true });
    const db = new DatabaseSync(lockPath, { timeout: 0, allowExtension: false });
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      db.exec("PRAGMA journal_mode = MEMORY");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("COMMIT");
      return new InstanceLock(db);
    } catch (caught) {
      db.close();
      if (isSqliteBusy(caught)) {
        throw new InstanceLockError(
          "Another DevDock instance is already using this data directory",
        );
      }
      throw caught;
    }
  }

  release(): void {
    this.#db?.close();
    this.#db = undefined;
  }
}

export class RegistryDatabase {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  static async open(path: string): Promise<RegistryDatabase> {
    const databasePath = path === ":memory:" ? path : resolve(path);
    if (databasePath !== ":memory:") await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath, { timeout: 1_000, allowExtension: false });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      if (databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
      migrate(db);
      return new RegistryDatabase(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  schemaVersion(): number {
    const row = one(this.#db, "PRAGMA user_version");
    const version = row?.user_version;
    if (typeof version !== "number") {
      throw new RegistryStorageError("DATA_INVALID", "SQLite schema version is invalid");
    }
    return version;
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #findByCanonicalPath(path: string): StoredProject | null {
    return projectFromRow(one(this.#db, "SELECT * FROM projects WHERE canonical_path = ?", path));
  }

  #findByIdentity(identityKey: string | null): StoredProject | null {
    if (identityKey === null) return null;
    return projectFromRow(
      one(this.#db, "SELECT * FROM projects WHERE identity_key = ?", identityKey),
    );
  }

  registerProject(input: ProjectRegistration): ProjectRecord {
    return this.#transaction(() => {
      const byPath = this.#findByCanonicalPath(input.canonicalPath);
      const byIdentity = this.#findByIdentity(input.identityKey);
      if (byPath !== null && byIdentity !== null && byPath.project.id !== byIdentity.project.id) {
        throw new RegistryStorageError(
          "PROJECT_IDENTITY_CHANGED",
          "Project path identity conflicts with an existing project",
        );
      }
      if (
        byPath !== null &&
        byPath.identityKey !== null &&
        byPath.identityKey !== input.identityKey
      ) {
        throw new RegistryStorageError(
          "PROJECT_IDENTITY_CHANGED",
          "Project directory identity has changed",
        );
      }
      const previous = byPath ?? byIdentity;
      if (previous !== null) {
        const project = ProjectRecordSchema.parse({
          ...previous.project,
          displayName: input.displayName,
          path: { displayPath: input.displayPath, canonicalPath: input.canonicalPath },
          archivedAt: undefined,
        });
        run(
          this.#db,
          `UPDATE projects SET display_name = ?, display_path = ?, canonical_path = ?,
           identity_key = ?, archived_at = NULL WHERE id = ?`,
          project.displayName,
          project.path.displayPath,
          project.path.canonicalPath,
          input.identityKey,
          project.id,
        );
        return project;
      }
      const project = ProjectRecordSchema.parse({
        id: randomUUID(),
        displayName: input.displayName,
        path: { displayPath: input.displayPath, canonicalPath: input.canonicalPath },
        createdAt: new Date().toISOString(),
      });
      run(
        this.#db,
        `INSERT INTO projects
         (id, display_name, display_path, canonical_path, identity_key, created_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        project.id,
        project.displayName,
        project.path.displayPath,
        project.path.canonicalPath,
        input.identityKey,
        project.createdAt,
      );
      return project;
    });
  }

  getProject(id: string): ProjectRecord | null {
    return (
      projectFromRow(one(this.#db, "SELECT * FROM projects WHERE id = ?", id))?.project ?? null
    );
  }

  getProjectIdentityKey(id: string): string | null {
    return (
      projectFromRow(one(this.#db, "SELECT * FROM projects WHERE id = ?", id))?.identityKey ?? null
    );
  }

  listProjects(includeArchived = false): ProjectRecord[] {
    const sql = includeArchived
      ? "SELECT * FROM projects ORDER BY created_at, id"
      : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at, id";
    return all(this.#db, sql).map((row) => {
      const stored = projectFromRow(row);
      if (stored === null)
        throw new RegistryStorageError("DATA_INVALID", "Stored project is invalid");
      return stored.project;
    });
  }

  archiveProject(id: string): ProjectRecord | null {
    run(
      this.#db,
      "UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
      new Date().toISOString(),
      id,
    );
    return this.getProject(id);
  }

  insertService(config: ServiceConfig): ServiceConfig {
    const validated = ServiceConfigSchema.parse(config);
    run(
      this.#db,
      "INSERT INTO services (id, project_id, config_json, created_at) VALUES (?, ?, ?, ?)",
      validated.id,
      validated.projectId,
      JSON.stringify(validated),
      new Date().toISOString(),
    );
    return validated;
  }

  updateService(config: ServiceConfig): ServiceConfig | null {
    const validated = ServiceConfigSchema.parse(config);
    const result = run(
      this.#db,
      "UPDATE services SET config_json = ? WHERE id = ? AND project_id = ?",
      JSON.stringify(validated),
      validated.id,
      validated.projectId,
    );
    return Number(result.changes) === 0 ? null : validated;
  }

  // Removes a service together with its run history. Returns false when it did not exist.
  deleteService(id: string): boolean {
    return this.#transaction(() => {
      run(this.#db, "DELETE FROM runs WHERE service_id = ?", id);
      return Number(run(this.#db, "DELETE FROM services WHERE id = ?", id).changes) > 0;
    });
  }

  getService(id: string): ServiceConfig | null {
    const row = one(this.#db, "SELECT config_json FROM services WHERE id = ?", id);
    if (row === undefined) return null;
    try {
      return ServiceConfigSchema.parse(readJson(row.config_json, "service"));
    } catch {
      throw new RegistryStorageError("DATA_INVALID", "Stored service is invalid");
    }
  }

  listServices(projectId: string): ServiceConfig[] {
    return all(
      this.#db,
      "SELECT config_json FROM services WHERE project_id = ? ORDER BY created_at, id",
      projectId,
    ).map((row) => {
      try {
        return ServiceConfigSchema.parse(readJson(row.config_json, "service"));
      } catch {
        throw new RegistryStorageError("DATA_INVALID", "Stored service is invalid");
      }
    });
  }

  insertProfile(config: ProfileConfig): ProfileConfig {
    const validated = ProfileConfigSchema.parse(config);
    run(
      this.#db,
      "INSERT INTO profiles (id, project_id, config_json, created_at) VALUES (?, ?, ?, ?)",
      validated.id,
      validated.projectId,
      JSON.stringify(validated),
      new Date().toISOString(),
    );
    return validated;
  }

  updateProfile(config: ProfileConfig): ProfileConfig | null {
    const validated = ProfileConfigSchema.parse(config);
    const result = run(
      this.#db,
      "UPDATE profiles SET config_json = ? WHERE id = ? AND project_id = ?",
      JSON.stringify(validated),
      validated.id,
      validated.projectId,
    );
    return Number(result.changes) === 0 ? null : validated;
  }

  deleteProfile(id: string): boolean {
    return Number(run(this.#db, "DELETE FROM profiles WHERE id = ?", id).changes) > 0;
  }

  getProfile(id: string): ProfileConfig | null {
    const row = one(this.#db, "SELECT config_json FROM profiles WHERE id = ?", id);
    if (row === undefined) return null;
    try {
      return ProfileConfigSchema.parse(readJson(row.config_json, "profile"));
    } catch {
      throw new RegistryStorageError("DATA_INVALID", "Stored profile is invalid");
    }
  }

  listProfiles(projectId: string): ProfileConfig[] {
    return all(
      this.#db,
      "SELECT config_json FROM profiles WHERE project_id = ? ORDER BY created_at, id",
      projectId,
    ).map((row) => {
      try {
        return ProfileConfigSchema.parse(readJson(row.config_json, "profile"));
      } catch {
        throw new RegistryStorageError("DATA_INVALID", "Stored profile is invalid");
      }
    });
  }

  saveRunSnapshot(snapshot: RunSnapshot): RunSnapshot {
    const validated = RunSnapshotSchema.parse(snapshot);
    const result = run(
      this.#db,
      `INSERT INTO runs (run_id, service_id, snapshot_json, recorded_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET snapshot_json = excluded.snapshot_json,
       recorded_at = excluded.recorded_at WHERE runs.service_id = excluded.service_id`,
      validated.runId,
      validated.serviceId,
      JSON.stringify(validated),
      new Date().toISOString(),
    );
    if (result.changes === 0) {
      throw new RegistryStorageError("DATA_INVALID", "Run ID belongs to a different service");
    }
    return validated;
  }

  listRuns(serviceId: string): RunSnapshot[] {
    return all(
      this.#db,
      "SELECT snapshot_json FROM runs WHERE service_id = ? ORDER BY recorded_at, run_id",
      serviceId,
    ).map((row) => {
      try {
        const snapshot = RunSnapshotSchema.parse(readJson(row.snapshot_json, "run"));
        if (snapshot.serviceId !== serviceId) throw new Error("Run service mismatch");
        return snapshot;
      } catch {
        throw new RegistryStorageError("DATA_INVALID", "Stored run is invalid");
      }
    });
  }

  getSettings(): AppSettings {
    const row = one(this.#db, "SELECT value_json FROM settings WHERE key = ?", "app");
    if (row === undefined) return AppSettingsSchema.parse({});
    try {
      return AppSettingsSchema.parse(readJson(row.value_json, "settings"));
    } catch {
      throw new RegistryStorageError("DATA_INVALID", "Stored settings are invalid");
    }
  }

  saveSettings(input: AppSettings): AppSettings {
    const settings = AppSettingsSchema.parse(input);
    run(
      this.#db,
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      "app",
      JSON.stringify(settings),
    );
    return settings;
  }
}
