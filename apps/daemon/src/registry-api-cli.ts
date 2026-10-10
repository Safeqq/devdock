import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
  resolveDataDirectory,
} from "@devdock/platform";
import { InstanceLock, InstanceLockError, RegistryDatabase } from "@devdock/storage";
import { DesktopBridge } from "./desktop-bridge.js";
import { createLocalApiServer } from "./local-api.js";
import { ProfileRuntimeManager } from "./profile-runtime-manager.js";
import { ProjectRegistry } from "./project-registry.js";
import { ServiceRuntimeManager } from "./service-runtime-manager.js";

const INSTANCE_LOCKED_EXIT_CODE = 3;
const CONTROL_LINE_LIMIT = 1_024;

function writeEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isControlMessage(message: unknown, type: string): boolean {
  return (
    message !== null && typeof message === "object" && "type" in message && message.type === type
  );
}

// A parent such as the desktop shell owns this process through its stdin pipe. It can request
// shutdown, a fresh pairing code, or stopping every script with JSON lines, and when the pipe
// closes because the parent exited or crashed, the daemon shuts down instead of being left
// holding services.
function listenForParentControl(
  close: () => void,
  issuePairingCode: () => string,
  stopAll: () => void,
): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (line.length > CONTROL_LINE_LIMIT) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (isControlMessage(message, "shutdown")) close();
    else if (isControlMessage(message, "issue-pairing-code")) {
      writeEvent({ type: "pairing-code", pairingCode: issuePairingCode() });
    } else if (isControlMessage(message, "stop-all")) stopAll();
  });
  lines.once("close", close);
}

async function main(): Promise<void> {
  const portText = process.env.DEVDOCK_PORT ?? "4317";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("DEVDOCK_PORT must be an integer between 0 and 65535");
  }
  const dataDirectory = resolveDataDirectory();
  let lock: InstanceLock;
  try {
    lock = await InstanceLock.acquire(join(dataDirectory, "instance.lock"));
  } catch (caught) {
    if (caught instanceof InstanceLockError) {
      writeEvent({ type: "registry-api-error", code: caught.code, message: caught.message });
      console.error(caught.message);
      process.exitCode = INSTANCE_LOCKED_EXIT_CODE;
      return;
    }
    throw caught;
  }
  let store: RegistryDatabase;
  try {
    store = await RegistryDatabase.open(join(dataDirectory, "registry.sqlite"));
  } catch (caught) {
    lock.release();
    throw caught;
  }
  let api: ReturnType<typeof createLocalApiServer> | undefined;
  try {
    const launcher = await NpmLauncher.locatePreferred();
    const registry = new ProjectRegistry(store);
    const runtime = productionProcessControlAvailable()
      ? new ServiceRuntimeManager({
          registry,
          launcher,
          adapterFactory: () => createPlatformProcessAdapter(),
        })
      : undefined;
    const profileRuntime =
      runtime === undefined ? undefined : new ProfileRuntimeManager({ registry, runtime });
    const require = createRequire(import.meta.url);
    const webRoot = join(dirname(require.resolve("@devdock/web/package.json")), "dist");
    api = createLocalApiServer({
      registry,
      launcher,
      webRoot,
      ...(runtime === undefined || profileRuntime === undefined ? {} : { runtime, profileRuntime }),
    });
    const origin = await api.listen(port);
    writeEvent({
      type: "registry-api-ready",
      origin,
      pairingCode: api.pairingCode,
      projectNode: { source: launcher.nodeSource, executable: launcher.nodeExecutable },
    });
    // Only a desktop parent shows tray counts and notifications, so only it receives them.
    const bridge =
      process.env.DEVDOCK_CONTROL === "stdin" &&
      runtime !== undefined &&
      profileRuntime !== undefined
        ? new DesktopBridge({ registry, runtime, profileRuntime, emit: writeEvent })
        : undefined;
    let closing = false;
    const close = () => {
      if (closing || api === undefined) return;
      closing = true;
      bridge?.close();
      const runningApi = api;
      void (async () => {
        try {
          await runningApi.close();
        } catch {
          process.exitCode = 1;
        }
        try {
          store.close();
        } catch {
          process.exitCode = 1;
        }
        lock.release();
        if (process.connected) process.disconnect();
        // The parent control pipe keeps stdin open; release it so the process can exit.
        process.stdin.destroy();
      })();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    if (process.platform !== "win32") process.once("SIGHUP", close);
    process.once("message", (message: unknown) => {
      if (isControlMessage(message, "shutdown")) close();
    });
    if (process.env.DEVDOCK_CONTROL === "stdin") {
      const runningApi = api;
      listenForParentControl(
        close,
        () => runningApi.issuePairingCode(),
        () => {
          if (!closing) void bridge?.stopAll();
        },
      );
    }
  } catch (caught) {
    try {
      if (api !== undefined) await api.close();
    } finally {
      store.close();
      lock.release();
    }
    throw caught;
  }
}

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : "Registry API failed to start");
  process.exitCode = 1;
});
