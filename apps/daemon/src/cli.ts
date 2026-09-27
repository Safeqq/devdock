import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type ManagedProcessHandle, WindowsFixtureProcessAdapter } from "@devdock/platform";

const fixturePath = fileURLToPath(
  new URL("../../../tests/fixtures/http-server.mjs", import.meta.url),
);

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Fixture control is currently available only on native Windows");
  }

  const adapter = new WindowsFixtureProcessAdapter();
  const canonicalCwd = await realpath(dirname(fixturePath));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let active: ManagedProcessHandle | undefined;

  async function stop(): Promise<void> {
    const handle = active;
    if (handle === undefined) {
      emit({ type: "stopped", alreadyStopped: true });
      return;
    }

    const request = await adapter.requestGracefulStop(handle);
    if (request !== "requested" && request !== "already_exited") {
      process.exitCode = 1;
      emit({ type: "error", code: "STOP_UNAVAILABLE", reason: request, runId: handle.runId });
      return;
    }

    const result = await adapter.waitForExit(handle, 3_000);
    if (result.kind === "exited") {
      active = undefined;
      emit({ type: "stopped", runId: handle.runId, code: result.code, signal: result.signal });
      return;
    }

    const fallback = await adapter.terminateOwnedTree(handle);
    process.exitCode = 1;
    emit({ type: "error", code: "STOP_UNCONFIRMED", reason: result.kind, fallback });
  }

  process.once("SIGINT", () => input.close());
  process.once("SIGTERM", () => input.close());
  emit({ type: "ready", commands: ["start", "inspect", "stop", "exit"] });

  try {
    for await (const line of input) {
      const command = line.trim();
      if (command === "start") {
        if (active !== undefined) {
          const ownership = await adapter.inspectOwnership(active);
          if (ownership === "owned") {
            emit({ type: "started", existing: true, runId: active.runId, pid: active.pid });
            continue;
          }
          if (ownership === "unknown") {
            emit({ type: "error", code: "OWNERSHIP_UNKNOWN", runId: active.runId });
            continue;
          }
          active = undefined;
        }

        const handle = await adapter.start({
          runId: randomUUID(),
          executable: process.execPath,
          args: [fixturePath],
          canonicalCwd,
          env: { PORT: "0" },
        });
        active = handle;
        handle.stdout.pipe(process.stdout, { end: false });
        handle.stderr.pipe(process.stderr, { end: false });
        emit({ type: "started", existing: false, runId: handle.runId, pid: handle.pid });
      } else if (command === "inspect") {
        if (active === undefined) {
          emit({ type: "inspection", status: "stopped" });
        } else {
          emit({
            type: "inspection",
            status: await adapter.inspectOwnership(active),
            runId: active.runId,
            pid: active.pid,
            gracefulStop: active.gracefulStop,
          });
        }
      } else if (command === "stop") {
        await stop();
      } else if (command === "exit") {
        input.close();
        break;
      } else if (command !== "") {
        emit({ type: "error", code: "UNKNOWN_COMMAND", command });
      }
    }
  } finally {
    if (active !== undefined) await stop();
    input.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fixture control failed");
  process.exitCode = 1;
});
