import type {
  FolderInspection,
  ProfileConfig,
  ProfileOperationSnapshot,
  ProjectRecord,
  RunSnapshot,
  ScriptDiscovery,
  ServiceConfig,
  ServiceLeftover,
  SystemInfo,
} from "@devdock/contracts";

export type Project = ProjectRecord;
export type Service = ServiceConfig;
export type Profile = ProfileConfig;
export type Discovery = ScriptDiscovery;
export type {
  FolderInspection,
  ProfileOperationSnapshot,
  RunSnapshot,
  ServiceLeftover,
  SystemInfo,
};

export interface ProjectDetail {
  project: Project;
  services: Service[];
  profiles: Profile[];
}

export interface ServiceStatus {
  snapshot: RunSnapshot | null;
  ownership: "owned" | "exited" | "unknown" | null;
  appUrl: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope =
      data !== null && typeof data === "object" && "error" in data ? data.error : null;
    const code =
      envelope !== null &&
      typeof envelope === "object" &&
      "code" in envelope &&
      typeof envelope.code === "string"
        ? envelope.code
        : "REQUEST_FAILED";
    const message =
      envelope !== null &&
      typeof envelope === "object" &&
      "message" in envelope &&
      typeof envelope.message === "string"
        ? envelope.message
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, code, message);
  }
  try {
    return parse(data);
  } catch {
    throw new ApiError(502, "RESPONSE_INVALID", "Server returned unexpected data");
  }
}

export async function apiGet<T>(
  path: string,
  parse: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  return readResponse(response, parse);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
  csrfToken?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...(csrfToken === undefined ? {} : { "x-devdock-csrf": csrfToken }),
    },
    body: JSON.stringify(body),
  });
  return readResponse(response, parse);
}

// Start and Stop answer with an outcome even when it is a refusal (409) or a failure (500); the
// outcome explains what happened, so it is returned instead of a generic error.
export async function apiAction<T>(
  path: string,
  parse: (value: unknown) => T,
  csrfToken: string,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", "x-devdock-csrf": csrfToken },
    body: "{}",
  });
  if (response.status === 409 || response.status === 500) {
    const data: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (data !== null && typeof data === "object" && "outcome" in data) {
      try {
        return parse(data);
      } catch {
        // Fall through to the normal error envelope handling.
      }
    }
  }
  return readResponse(response, parse);
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Only plain loopback addresses on this computer may be opened from the dashboard.
export function safeOpenAppUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !loopbackHosts.has(parsed.hostname) ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// What a user should read when a request fails: what happened and what to do next. The technical
// code stays available for bug reports but is not the headline.
const friendlyMessages: Record<string, string> = {
  PACKAGE_NOT_FOUND:
    "There is no package.json in this folder. Choose the folder that contains package.json.",
  PACKAGE_JSON_INVALID:
    "package.json in this folder could not be read. Check that it is valid JSON.",
  PACKAGE_SCRIPTS_INVALID: "The scripts in package.json are not in the expected format.",
  PACKAGE_TOO_LARGE: "package.json is too large for DevDock to read (over 1 MB).",
  PACKAGE_UNREADABLE: "package.json could not be read. Check the file's permissions.",
  PATH_INVALID: "Enter the full path to the folder, for example C:\\Code\\my-app.",
  DIRECTORY_UNREADABLE: "That folder does not exist or cannot be opened. Check the path.",
  DIRECTORY_REQUIRED: "That path is a file, not a folder.",
  NETWORK_PATH_UNSUPPORTED: "Folders on network drives are not supported. Use a local folder.",
  PROJECT_IDENTITY_CHANGED:
    "This project's folder was moved or replaced. Remove it from DevDock and add it again.",
  PROJECT_ARCHIVED: "This project was removed from DevDock. Add it again to use it.",
  PROJECT_NOT_FOUND: "This project no longer exists in DevDock.",
  PROJECT_HAS_ACTIVE_SERVICES: "Stop the scripts that are running in this project first.",
  PROJECT_HAS_ACTIVE_PROFILES: "Stop the groups that are running in this project first.",
  SCRIPT_NOT_FOUND: "This script is no longer in package.json.",
  SERVICE_ENV_FILE_UNAVAILABLE:
    "An environment file listed in this script's settings is missing or cannot be read.",
  SERVICE_ENV_KEY_MISSING:
    "A required environment variable is missing. Check the Environment section in the script's settings.",
  SERVICE_CONFIG_INVALID: "These settings are not valid. Check the highlighted values.",
  SERVICE_CONTROL_UNAVAILABLE: "Running scripts is not supported on this system.",
  OPEN_APP_PORT_UNCONFIGURED:
    "DevDock does not know your app's address yet. Add its port in the script's settings.",
  PROFILE_CYCLE: "These scripts wait for each other in a loop, so none of them could start.",
  PROFILE_CONFIG_INVALID: "This group is not valid. Give it a name and choose at least one script.",
  PROFILE_ACTIVE: "Stop the group before changing or deleting it.",
  PROFILE_NOT_FOUND: "This group no longer exists.",
  SERVICE_ACTIVE: "Stop this script before resetting it.",
  SERVICE_IN_GROUP: "This script is part of a group. Remove it from the group first.",
  RUN_NOT_UNKNOWN: "DevDock already knows this script's status. Nothing to check.",
  MARKED_STOPPED_BY_USER: "You marked it as stopped.",
  OWNERSHIP_UNKNOWN:
    "DevDock can't tell whether this is still running from an earlier session, so it won't start a second copy.",
  PROCESS_EXITED_WITH_FAILURE: "It stopped with an error; its output shows why.",
  READINESS_TIMEOUT: "It didn't answer on its port in time.",
  SPAWN_ERROR: "It could not be launched. Check that Node.js and npm are installed.",
  STARTUP_FAILED: "It stopped before it was ready; its output shows why.",
  DAEMON_RESTART_OWNERSHIP_UNKNOWN:
    "DevDock restarted while it was running, so it can't tell whether it still is.",
  CLEANUP_PENDING: "DevDock is still cleaning up the last run. Try again in a moment.",
  STOP_INCOMPLETE: "DevDock could not confirm the last run stopped. Try stopping it again.",
  SESSION_REQUIRED: "Your session ended. Reconnecting…",
  EVENT_CLIENT_LIMIT: "Too many output windows are open. Close some DevDock tabs and try again.",
  INSTANCE_LOCKED: "Another copy of DevDock is already running.",
};

export function friendlyError(caught: unknown): { message: string; code: string | null } {
  if (caught instanceof ApiError) {
    return { message: friendlyMessages[caught.code] ?? caught.message, code: caught.code };
  }
  return {
    message:
      "DevDock's engine did not answer. Check that DevDock is still running, then try again.",
    code: null,
  };
}

export function reasonMessage(reason: string): string {
  return friendlyMessages[reason] ?? `Something went wrong (${reason}).`;
}
