import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WindowsFixtureProcessAdapter } from "@devdock/platform";
import { SingleServiceSupervisor, type StartOutcome } from "./single-service-supervisor.js";

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

  const canonicalCwd = await realpath(dirname(fixturePath));
  const supervisor = new SingleServiceSupervisor(new WindowsFixtureProcessAdapter(), {
    executable: process.execPath,
    args: [fixturePath],
    canonicalCwd,
    env: { PORT: "0" },
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

  function reportStart(outcome: StartOutcome): void {
    if (outcome.kind === "failed" || outcome.kind === "rejected") {
      emit({ type: "error", code: outcome.reason, snapshot: outcome.snapshot });
      return;
    }
    const { snapshot } = outcome;
    if (outcome.kind === "started") {
      const streams = supervisor.streamsFor(snapshot.runId);
      streams?.stdout.pipe(process.stdout, { end: false });
      streams?.stderr.pipe(process.stderr, { end: false });
    }
    emit({
      type: "started",
      existing: outcome.kind === "existing",
      runId: snapshot.runId,
      pid: snapshot.pid,
      processState: snapshot.processState,
      readinessState: snapshot.readinessState,
    });
  }

  async function stop(): Promise<void> {
    const outcome = await supervisor.stop();
    if (outcome.kind === "incomplete") {
      process.exitCode = 1;
      emit({
        type: "error",
        code: "STOP_UNCONFIRMED",
        reason: outcome.reason,
        snapshot: outcome.snapshot,
      });
      return;
    }
    emit({
      type: "stopped",
      alreadyStopped: outcome.kind === "already_stopped",
      runId: outcome.snapshot?.runId,
      code: outcome.snapshot?.exitCode,
      processState: outcome.snapshot?.processState,
    });
  }

  process.once("SIGINT", () => input.close());
  process.once("SIGTERM", () => input.close());
  emit({ type: "ready", commands: ["start", "inspect", "stop", "restart", "exit"] });

  try {
    for await (const line of input) {
      const command = line.trim();
      if (command === "start") {
        reportStart(await supervisor.start());
      } else if (command === "inspect") {
        const { snapshot, ownership } = await supervisor.inspect();
        emit({
          type: "inspection",
          status: snapshot?.processState ?? "stopped",
          ownership,
          runId: snapshot?.runId,
          pid: snapshot?.pid,
          readinessState: snapshot?.readinessState ?? "unknown",
          reconciliationState: snapshot?.reconciliationState ?? "known",
          exitCode: snapshot?.exitCode,
          failureReason: snapshot?.failureReason,
        });
      } else if (command === "stop") {
        await stop();
      } else if (command === "restart") {
        const outcome = await supervisor.restart();
        if (outcome.kind === "incomplete") {
          process.exitCode = 1;
          emit({
            type: "error",
            code: "RESTART_BLOCKED",
            reason: outcome.reason,
            snapshot: outcome.snapshot,
          });
        } else {
          reportStart(outcome);
        }
      } else if (command === "exit") {
        input.close();
        break;
      } else if (command !== "") {
        emit({ type: "error", code: "UNKNOWN_COMMAND", command });
      }
    }
  } finally {
    const outcome = await supervisor.stop();
    if (outcome.kind === "incomplete") {
      process.exitCode = 1;
      emit({
        type: "error",
        code: "STOP_UNCONFIRMED",
        reason: outcome.reason,
        snapshot: outcome.snapshot,
      });
    }
    input.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fixture control failed");
  process.exitCode = 1;
});
