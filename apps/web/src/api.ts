import type {
  ProfileConfig,
  ProjectRecord,
  ScriptDiscovery,
  ServiceConfig,
} from "@devdock/contracts";

export type Project = ProjectRecord;
export type Service = ServiceConfig;
export type Profile = ProfileConfig;
export type Discovery = ScriptDiscovery;

export interface ProjectDetail {
  project: Project;
  services: Service[];
  profiles: Profile[];
}

export interface CommandPreview {
  executable: string;
  args: string[];
  cwd: string;
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

export function safeOpenAppUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
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
