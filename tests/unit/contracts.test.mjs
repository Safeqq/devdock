import assert from "node:assert/strict";
import { test } from "node:test";

import { RunSnapshotSchema, ServiceConfigSchema } from "@devdock/contracts";

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
