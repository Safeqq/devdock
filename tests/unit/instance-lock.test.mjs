import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InstanceLock } from "../../packages/storage/dist/index.js";

test("instance lock admits one holder per data directory until it is released", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "devdock-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lockPath = join(directory, "nested", "instance.lock");

  const first = await InstanceLock.acquire(lockPath);
  await assert.rejects(InstanceLock.acquire(lockPath), {
    name: "InstanceLockError",
    code: "INSTANCE_LOCKED",
  });

  first.release();
  first.release();
  const second = await InstanceLock.acquire(lockPath);
  second.release();
});
