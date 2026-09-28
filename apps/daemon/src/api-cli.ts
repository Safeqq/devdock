import { createLocalApiServer } from "./local-api.js";

async function main(): Promise<void> {
  const portText = process.env.DEVDOCK_PORT ?? "4317";
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("DEVDOCK_PORT must be an integer between 0 and 65535");
  }
  const api = createLocalApiServer();
  try {
    const origin = await api.listen(port);
    process.stdout.write(
      `${JSON.stringify({ type: "api-ready", origin, pairingCode: api.pairingCode })}\n`,
    );
    const close = () => {
      void api.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (caught) {
    await api.close();
    throw caught;
  }
}

main().catch((caught: unknown) => {
  console.error(caught instanceof Error ? caught.message : "Local API failed to start");
  process.exitCode = 1;
});
