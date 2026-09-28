import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NpmLauncher, resolveDataDirectory } from "@devdock/platform";
import { RegistryDatabase } from "@devdock/storage";
import { createLocalApiServer } from "./local-api.js";
import { ProjectRegistry } from "./project-registry.js";

async function main(): Promise<void> {
  const databasePath = join(resolveDataDirectory(), "registry.sqlite");
  const store = await RegistryDatabase.open(databasePath);
  let api: ReturnType<typeof createLocalApiServer> | undefined;
  try {
    const launcher = await NpmLauncher.locate();
    const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
    api = createLocalApiServer({ registry: new ProjectRegistry(store), launcher, webRoot });
    const origin = await api.listen(4_317);
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
      })();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
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
