import { PosixProcessGroupAdapter } from "./posix-process-group-adapter.js";
import type { ProcessAdapter } from "./process-adapter.js";
import { WindowsJobProcessAdapter } from "./windows-job-process-adapter.js";

export function productionProcessControlAvailable(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" || platform === "darwin" || platform === "linux";
}

export function createPlatformProcessAdapter(
  platform: NodeJS.Platform = process.platform,
): ProcessAdapter {
  if (platform === "win32") return new WindowsJobProcessAdapter();
  if (platform === "darwin" || platform === "linux") return new PosixProcessGroupAdapter();
  throw new Error(`Service process control is unavailable on ${platform}`);
}
