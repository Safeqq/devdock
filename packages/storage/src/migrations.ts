export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        display_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        identity_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;

      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX services_project_id_idx ON services(project_id);

      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
        snapshot_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX runs_service_id_idx ON runs(service_id, recorded_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX profiles_project_id_idx ON profiles(project_id, created_at, id);
    `,
  },
] as const;
