import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  CreateProfileRequestSchema,
  RunSnapshotSchema,
  SelectServiceRequestSchema,
  ServiceConfigSchema,
} from "@devdock/contracts";

const service = {
  id: "api",
  projectId: "demo",
  displayName: "API",
  scriptName: "dev",
  cwd: { displayPath: "./demo", canonicalPath: "C:\\demo" },
  readiness: { kind: "http", path: "/ready", timeoutMs: 5_000 },
};

test("a readiness probe requires an expected port", () => {
  const missingPort = ServiceConfigSchema.safeParse(service);
  assert.equal(missingPort.success, false);

  const configured = ServiceConfigSchema.safeParse({ ...service, expectedPort: 4300 });
  assert.equal(configured.success, true);
  assert.deepEqual(configured.data.envFiles, []);
  assert.deepEqual(configured.data.requiredEnvKeys, []);
  assert.deepEqual(configured.data.restartPolicy, { kind: "off" });
});

test("restart policy is opt-in and bounded", () => {
  const configured = SelectServiceRequestSchema.parse({
    scriptName: "dev",
    restartPolicy: {
      kind: "on_failure",
      maxAttempts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1_000,
    },
  });
  assert.equal(configured.restartPolicy.kind, "on_failure");
  assert.deepEqual(SelectServiceRequestSchema.parse({ scriptName: "dev" }).restartPolicy, {
    kind: "off",
  });
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      restartPolicy: {
        kind: "on_failure",
        maxAttempts: 11,
        initialBackoffMs: 1_000,
        maxBackoffMs: 100,
      },
    }).success,
    false,
  );
});

test("environment diagnostics configuration only accepts bounded portable names", () => {
  const configured = SelectServiceRequestSchema.parse({
    scriptName: "dev",
    envFiles: [".env", ".env.local"],
    requiredEnvKeys: ["DATABASE_URL", "API_TOKEN_2"],
  });
  assert.deepEqual(configured.envFiles, [".env", ".env.local"]);
  assert.deepEqual(configured.requiredEnvKeys, ["DATABASE_URL", "API_TOKEN_2"]);
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      envFiles: [".env", ".env"],
    }).success,
    false,
  );
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      requiredEnvKeys: ["NOT-PORTABLE"],
    }).success,
    false,
  );
});

test("readiness configuration requires a port and a loopback-safe HTTP path", () => {
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      readiness: { kind: "tcp", timeoutMs: 1_000 },
    }).success,
    false,
  );
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      expectedPort: 4_300,
      readiness: { kind: "http", path: "//example.invalid/ready", timeoutMs: 1_000 },
    }).success,
    false,
  );
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      expectedPort: 4_300,
      readiness: { kind: "http", path: "/ready#fragment", timeoutMs: 1_000 },
    }).success,
    false,
  );
  assert.equal(
    SelectServiceRequestSchema.safeParse({
      scriptName: "dev",
      expectedPort: 4_300,
      readiness: { kind: "http", path: "/ready", timeoutMs: 1_000 },
    }).success,
    true,
  );
});

test("unknown readiness and ownership remain distinct from a running process", () => {
  const result = RunSnapshotSchema.safeParse({
    runId: "run-1",
    serviceId: "api",
    processState: "running",
    readinessState: "unknown",
    reconciliationState: "unknown",
    startedAt: "2026-09-27T00:00:00Z",
  });
  assert.equal(result.success, true);
  assert.equal(result.data.processState, "running");
  assert.equal(result.data.readinessState, "unknown");
});

test("service input rejects fields outside its runtime contract", () => {
  const result = ServiceConfigSchema.safeParse({
    ...service,
    expectedPort: 4300,
    command: "arbitrary shell text",
  });
  assert.equal(result.success, false);
});

test("profile input requires unique members and internal dependency references", () => {
  const api = randomUUID();
  const web = randomUUID();
  assert.equal(
    CreateProfileRequestSchema.safeParse({
      displayName: "Full Stack",
      services: [
        { serviceId: api, dependsOn: [] },
        { serviceId: web, dependsOn: [api] },
      ],
    }).success,
    true,
  );
  assert.equal(
    CreateProfileRequestSchema.safeParse({
      displayName: "Duplicate",
      services: [
        { serviceId: api, dependsOn: [] },
        { serviceId: api, dependsOn: [] },
      ],
    }).success,
    false,
  );
  assert.equal(
    CreateProfileRequestSchema.safeParse({
      displayName: "Outside dependency",
      services: [{ serviceId: web, dependsOn: [api] }],
    }).success,
    false,
  );
});
