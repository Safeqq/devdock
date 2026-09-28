import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export class DataDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDirectoryError";
  }
}

export function resolveDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const paths = platform === "win32" ? win32 : posix;
  if (!paths.isAbsolute(home)) {
    throw new DataDirectoryError("User home directory must be an absolute path");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    return paths.join(
      localAppData && paths.isAbsolute(localAppData)
        ? localAppData
        : paths.join(home, "AppData", "Local"),
      "DevDock",
    );
  }
  if (platform === "darwin") {
    return paths.join(home, "Library", "Application Support", "DevDock");
  }
  const xdgDataHome = env.XDG_DATA_HOME;
  return paths.join(
    xdgDataHome && paths.isAbsolute(xdgDataHome)
      ? xdgDataHome
      : paths.join(home, ".local", "share"),
    "devdock",
  );
}
