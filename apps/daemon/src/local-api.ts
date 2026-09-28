import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { PairingRequestSchema } from "@devdock/contracts";
import type { NpmLauncher } from "@devdock/platform";
import { ProjectFileError } from "@devdock/platform";
import { RegistryStorageError } from "@devdock/storage";
import fastifyStatic from "@fastify/static";
import fastify, { type FastifyRequest } from "fastify";
import { type ProjectRegistry, ProjectRegistryError } from "./project-registry.js";
import { registerProjectRoutes } from "./project-routes.js";

const COOKIE_NAME = "devdock_session";
const PAIRING_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_EVENT_CLIENTS = 8;

interface Session {
  token: string;
  csrfToken: string;
  expiresAt: number;
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sessionCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  let token: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== COOKIE_NAME) continue;
    if (token !== null) return null;
    const value = part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
    token = value;
  }
  return token;
}

function error(code: string, message: string) {
  return { error: { code, message } };
}

export interface LocalApiOptions {
  now?: () => number;
  registry?: ProjectRegistry;
  launcher?: NpmLauncher;
  webRoot?: string;
}

function publicWebPath(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return url === "/" || /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|svg|woff2)$/u.test(url);
}

function projectError(caught: unknown): { status: number; code: string; message: string } | null {
  if (caught instanceof ProjectRegistryError) {
    const status =
      caught.code === "PROJECT_NOT_FOUND" || caught.code === "SERVICE_NOT_FOUND"
        ? 404
        : caught.code === "PROJECT_ARCHIVED" ||
            caught.code === "PROJECT_IDENTITY_CHANGED" ||
            caught.code === "OPEN_APP_PORT_UNCONFIGURED"
          ? 409
          : 400;
    return { status, code: caught.code, message: caught.message };
  }
  if (caught instanceof ProjectFileError) {
    const status = caught.code === "PACKAGE_NOT_FOUND" ? 404 : 400;
    return { status, code: caught.code, message: caught.message };
  }
  if (caught instanceof RegistryStorageError && caught.code === "PROJECT_IDENTITY_CHANGED") {
    return { status: 409, code: caught.code, message: caught.message };
  }
  return null;
}

export function createLocalApiServer(options: LocalApiOptions = {}) {
  if ((options.registry === undefined) !== (options.launcher === undefined)) {
    throw new Error("Registry and launcher must be configured together");
  }
  const now = options.now ?? Date.now;
  const app = fastify({ logger: false, bodyLimit: 1_024, trustProxy: false });
  const pairingCode = randomToken(16);
  const pairingExpiresAt = now() + PAIRING_TTL_MS;
  let failedPairingAttempts = 0;
  let pairingUsed = false;
  let session: Session | null = null;
  const eventClients = new Map<ServerResponse, NodeJS.Timeout>();

  function expectedOrigin(): string | null {
    const address = app.server.address();
    if (address === null || typeof address === "string") return null;
    return `http://127.0.0.1:${address.port}`;
  }

  function currentSession(request: FastifyRequest): Session | null {
    const token = sessionCookie(request.headers.cookie);
    if (token === null || session === null || now() >= session.expiresAt) return null;
    return equalSecret(token, session.token) ? session : null;
  }

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    const origin = expectedOrigin();
    if (origin === null || request.headers.host !== origin.slice("http://".length)) {
      return reply.code(421).send(error("HOST_INVALID", "Request host is not allowed"));
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) {
      return reply.code(403).send(error("ORIGIN_INVALID", "Request origin is not allowed"));
    }
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (mutation && requestOrigin !== origin) {
      return reply.code(403).send(error("ORIGIN_REQUIRED", "A matching Origin header is required"));
    }
    if (options.webRoot !== undefined && publicWebPath(request.method, request.url)) return;
    if (request.method === "POST" && request.url === "/api/pair") return;
    const authorized = currentSession(request);
    if (authorized === null) {
      return reply.code(401).send(error("SESSION_REQUIRED", "A valid session is required"));
    }
    if (mutation) {
      const csrf = request.headers["x-devdock-csrf"];
      if (typeof csrf !== "string" || !equalSecret(csrf, authorized.csrfToken)) {
        return reply.code(403).send(error("CSRF_INVALID", "A valid CSRF token is required"));
      }
    }
  });

  app.setErrorHandler((caught, _request, reply) => {
    const known = projectError(caught);
    if (known !== null) {
      reply.code(known.status).send(error(known.code, known.message));
      return;
    }
    const status =
      typeof caught === "object" &&
      caught !== null &&
      "statusCode" in caught &&
      typeof caught.statusCode === "number" &&
      caught.statusCode < 500
        ? 400
        : 500;
    reply
      .code(status)
      .send(
        error(
          status === 400 ? "REQUEST_INVALID" : "INTERNAL_ERROR",
          "Request could not be processed",
        ),
      );
  });

  app.post("/api/pair", async (request, reply) => {
    const parsed = PairingRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(error("PAIRING_REQUEST_INVALID", "Pairing code is required"));
    }
    if (pairingUsed || now() >= pairingExpiresAt) {
      return reply
        .code(410)
        .send(error("PAIRING_UNAVAILABLE", "Pairing code has expired or was used"));
    }
    if (failedPairingAttempts >= MAX_PAIRING_ATTEMPTS) {
      return reply.code(429).send(error("PAIRING_RATE_LIMITED", "Too many pairing attempts"));
    }
    if (!equalSecret(parsed.data.code, pairingCode)) {
      failedPairingAttempts += 1;
      return reply.code(401).send(error("PAIRING_CODE_INVALID", "Pairing code is invalid"));
    }
    pairingUsed = true;
    session = {
      token: randomToken(32),
      csrfToken: randomToken(32),
      expiresAt: now() + SESSION_TTL_MS,
    };
    reply.header(
      "set-cookie",
      `${COOKIE_NAME}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}`,
    );
    return { csrfToken: session.csrfToken, expiresAt: new Date(session.expiresAt).toISOString() };
  });

  app.get("/api/session", async (request, reply) => {
    const authorized = currentSession(request);
    if (authorized === null) {
      return reply.code(401).send(error("SESSION_REQUIRED", "A valid session is required"));
    }
    return {
      csrfToken: authorized.csrfToken,
      expiresAt: new Date(authorized.expiresAt).toISOString(),
    };
  });

  app.post("/api/session/renew", async (request, reply) => {
    const authorized = currentSession(request);
    if (authorized === null) {
      return reply.code(401).send(error("SESSION_REQUIRED", "A valid session is required"));
    }
    authorized.csrfToken = randomToken(32);
    authorized.expiresAt = now() + SESSION_TTL_MS;
    reply.header(
      "set-cookie",
      `${COOKIE_NAME}=${authorized.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}`,
    );
    return {
      csrfToken: authorized.csrfToken,
      expiresAt: new Date(authorized.expiresAt).toISOString(),
    };
  });

  app.get("/api/events", (request, reply) => {
    const authorized = currentSession(request);
    if (authorized === null) {
      return reply.code(401).send(error("SESSION_REQUIRED", "A valid session is required"));
    }
    if (eventClients.size >= MAX_EVENT_CLIENTS) {
      return reply.code(429).send(error("EVENT_CLIENT_LIMIT", "Too many event connections"));
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");
    const heartbeat = setInterval(() => {
      if (now() >= authorized.expiresAt || !reply.raw.write(": heartbeat\n\n")) {
        reply.raw.end();
      }
    }, 15_000);
    heartbeat.unref();
    eventClients.set(reply.raw, heartbeat);
    reply.raw.once("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(reply.raw);
    });
  });

  app.addHook("preClose", async () => {
    for (const [response, heartbeat] of eventClients) {
      clearInterval(heartbeat);
      response.end();
    }
    eventClients.clear();
  });

  if (options.registry !== undefined && options.launcher !== undefined) {
    registerProjectRoutes(app, options.registry, options.launcher);
  }

  if (options.webRoot !== undefined) {
    const webRoot = options.webRoot;
    app.get("/", async (_request, reply) => {
      const html = await readFile(join(webRoot, "index.html"), "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    });
    app.register(fastifyStatic, {
      root: join(webRoot, "assets"),
      prefix: "/assets/",
      decorateReply: false,
    });
  }

  return {
    pairingCode,
    listen: (port: number) => app.listen({ host: "127.0.0.1", port }),
    close: () => app.close(),
  };
}
