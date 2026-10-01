import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createPlatformProcessAdapter,
  NpmLauncher,
  productionProcessControlAvailable,
  resolveDataDirectory,
} from "@devdock/platform";
import { RegistryDatabase } from "@devdock/storage";
import { createLocalApiServer } from "./local-api.js";
import { ProjectRegistry } from "./project-registry.js";
import { ServiceRuntimeManager } from "./service-runtime-manager.js";

async function main(): Promise<void> {
  const portText = process.env.DEVDOCK_PORT ?? "4317";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("DEVDOCK_PORT must be an integer between 0 and 65535");
  }
  const databasePath = join(resolveDataDirectory(), "registry.sqlite");
  const store = await RegistryDatabase.open(databasePath);
  let api: ReturnType<typeof createLocalApiServer> | undefined;
  try {
    const launcher = await NpmLauncher.locate();
    const registry = new ProjectRegistry(store);
    const runtime = productionProcessControlAvailable()
      ? new ServiceRuntimeManager({
          registry,
          launcher,
          adapterFactory: () => createPlatformProcessAdapter(),
        })
      : undefined;
    const require = createRequire(import.meta.url);
    const webRoot = join(dirname(require.resolve("@devdock/web/package.json")), "dist");
    api = createLocalApiServer({
      registry,
      launcher,
      webRoot,
      ...(runtime === undefined ? {} : { runtime }),
    });
    const origin = await api.listen(port);
    process.stdout.write(
      `${JSON.stringify({ type: "registry-api-ready", origin, pairingCode: api.pairingCode })}\n`,
    );
    let closing = false;
    const close = () => {
      if (closing || api === undefined) return;
      closing = true;
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
        if (process.connected) process.disconnect();
      })();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    if (process.platform !== "win32") process.once("SIGHUP", close);
    process.once("message", (message: unknown) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "shutdown"
      ) {
        close();
      }
    });
  } catch (caught) {
    try {
      if (api !== undefined) await api.close();
    } finally {
      store.close();
    }
    throw caught;
  }
}

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : "Registry API failed to start");
  process.exitCode = 1;
});
