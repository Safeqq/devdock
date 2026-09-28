import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { PairingRequestSchema } from "@devdock/contracts";
import fastify, { type FastifyRequest } from "fastify";

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

export function createLocalApiServer(now: () => number = Date.now) {
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

  return {
    pairingCode,
    listen: (port: number) => app.listen({ host: "127.0.0.1", port }),
    close: () => app.close(),
  };
}
