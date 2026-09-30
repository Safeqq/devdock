import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProfileGraphError, profileStartOrder } from "../../apps/daemon/dist/profile-graph.js";

test("profile graph returns dependencies before their consumers", () => {
  const database = randomUUID();
  const api = randomUUID();
  const web = randomUUID();
  assert.deepEqual(
    profileStartOrder({
      services: [
        { serviceId: web, dependsOn: [api] },
        { serviceId: database, dependsOn: [] },
        { serviceId: api, dependsOn: [database] },
      ],
    }),
    [database, api, web],
  );
});

test("profile graph reports the complete dependency cycle", () => {
  const database = randomUUID();
  const api = randomUUID();
  const web = randomUUID();
  assert.throws(
    () =>
      profileStartOrder({
        services: [
          { serviceId: database, dependsOn: [web] },
          { serviceId: api, dependsOn: [database] },
          { serviceId: web, dependsOn: [api] },
        ],
      }),
    (caught) => {
      assert.ok(caught instanceof ProfileGraphError);
      assert.deepEqual(caught.cycle, [database, web, api, database]);
      return true;
    },
  );
});
