import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { createLocalApiServer } from "../../apps/daemon/dist/local-api.js";

async function request(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3_000), ...options });
}

function pairRequest(origin, code) {
  return request(origin, "/api/pair", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

function requestWithHost(origin, host) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      { hostname: target.hostname, port: target.port, path: "/api/session", headers: { host } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    outbound.once("error", reject);
    outbound.end();
  });
}

test("local API guards pairing, sessions, CSRF, Host/Origin, and SSE", {
  timeout: 10_000,
}, async () => {
  const api = createLocalApiServer();
  const origin = await api.listen(0);
  try {
    assert.equal((await request(origin, "/api/session")).status, 401);
    assert.equal((await request(origin, "/api/events")).status, 401);
    assert.equal(await requestWithHost(origin, "attacker.example"), 421);
    assert.equal(
      (await request(origin, "/api/session", { headers: { origin: "http://attacker.example" } }))
        .status,
      403,
    );
    assert.equal(
      (
        await request(origin, "/api/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: api.pairingCode }),
        })
      ).status,
      403,
    );
    assert.equal((await pairRequest(origin, "wrong-code")).status, 401);

    const paired = await pairRequest(origin, api.pairingCode);
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie");
    assert.match(cookie, /devdock_session=[A-Za-z0-9_-]{43}/u);
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /SameSite=Strict/u);
    const sessionCookie = cookie.split(";")[0];
    const firstSession = await paired.json();
    assert.equal(typeof firstSession.csrfToken, "string");
    assert.equal((await pairRequest(origin, api.pairingCode)).status, 410);
    assert.equal(
      (await request(origin, "/api/session", { headers: { cookie: sessionCookie } })).status,
      200,
    );
    assert.equal(
      (
        await request(origin, "/api/session", {
          headers: { cookie: `${sessionCookie}; devdock_session=duplicate` },
        })
      ).status,
      401,
    );

    const renewal = { method: "POST", headers: { cookie: sessionCookie, origin } };
    assert.equal((await request(origin, "/api/session/renew", renewal)).status, 403);
    assert.equal(
      (
        await request(origin, "/api/session/renew", {
          method: "POST",
          headers: { cookie: sessionCookie, "x-devdock-csrf": firstSession.csrfToken },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(origin, "/api/session/renew", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            origin: "http://attacker.example",
            "x-devdock-csrf": firstSession.csrfToken,
          },
        })
      ).status,
      403,
    );
    const renewed = await request(origin, "/api/session/renew", {
      method: "POST",
      headers: { cookie: sessionCookie, origin, "x-devdock-csrf": firstSession.csrfToken },
    });
    assert.equal(renewed.status, 200);
    const nextSession = await renewed.json();
    assert.notEqual(nextSession.csrfToken, firstSession.csrfToken);
    assert.equal(
      (
        await request(origin, "/api/session/renew", {
          method: "POST",
          headers: { cookie: sessionCookie, origin, "x-devdock-csrf": firstSession.csrfToken },
        })
      ).status,
      403,
    );

    const events = await request(origin, "/api/events", { headers: { cookie: sessionCookie } });
    assert.equal(events.status, 200);
    assert.match(events.headers.get("content-type"), /text\/event-stream/u);
    const reader = events.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /: connected/u);
    await reader.cancel();
  } finally {
    await api.close();
  }
});

test("pairing attempts and session expiry are bounded", { timeout: 10_000 }, async () => {
  let currentTime = Date.now();
  const api = createLocalApiServer({ now: () => currentTime });
  const origin = await api.listen(0);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await pairRequest(origin, "invalid")).status, 401);
    }
    assert.equal((await pairRequest(origin, api.pairingCode)).status, 429);
  } finally {
    await api.close();
  }

  const another = createLocalApiServer({ now: () => currentTime });
  const secondOrigin = await another.listen(0);
  try {
    const paired = await pairRequest(secondOrigin, another.pairingCode);
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    currentTime += 8 * 60 * 60_000;
    assert.equal(
      (await request(secondOrigin, "/api/session", { headers: { cookie } })).status,
      401,
    );
    assert.equal((await request(secondOrigin, "/api/events", { headers: { cookie } })).status, 401);
  } finally {
    await another.close();
  }

  const expired = createLocalApiServer({ now: () => currentTime });
  const thirdOrigin = await expired.listen(0);
  try {
    currentTime += 5 * 60_000;
    assert.equal((await pairRequest(thirdOrigin, expired.pairingCode)).status, 410);
  } finally {
    await expired.close();
  }
});
