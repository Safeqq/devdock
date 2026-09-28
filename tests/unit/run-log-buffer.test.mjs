import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { RunLogBuffer } from "../../apps/daemon/dist/run-log-buffer.js";
import { LogEventSchema } from "../../packages/contracts/dist/index.js";

const sessionId = "daemon-session";
const runId = "run-one";
const fixedTime = "2026-09-28T00:00:00.000Z";

function buffer(options = {}) {
  return new RunLogBuffer(sessionId, runId, { ...options, now: () => new Date(fixedTime) });
}

test("stream capture decodes split UTF-8, separates stdout/stderr, and flushes partial lines", async () => {
  const logs = buffer();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  logs.capture(stdout, stderr);
  assert.throws(() => logs.capture(stdout, stderr), /already attached/);

  const emoji = Buffer.from("🙂");
  stdout.write(Buffer.concat([Buffer.from("hello "), emoji.subarray(0, 2)]));
  stdout.write(Buffer.concat([emoji.subarray(2), Buffer.from("\r")]));
  stdout.write("\nlast line");
  stderr.write("warning\n");
  const ends = Promise.all([once(stdout, "end"), once(stderr, "end")]);
  stdout.end();
  stderr.end();
  await ends;

  const replay = logs.replay();
  assert.deepEqual(
    replay.events.map(({ stream, text }) => [stream, text]),
    [
      ["stdout", "hello 🙂"],
      ["stderr", "warning"],
      ["stdout", "last line"],
    ],
  );
  assert.deepEqual(
    replay.events.map(({ sequence }) => sequence),
    [1, 2, 3],
  );
  assert.equal(replay.gap, false);
  for (const event of replay.events) {
    assert.deepEqual(LogEventSchema.parse(event), event);
    assert.equal(event.timestamp, fixedTime);
    assert.equal(event.daemonSessionId, sessionId);
    assert.equal(event.runId, runId);
  }
  assert.deepEqual(
    logs.replay(2).events.map(({ text }) => text),
    ["last line"],
  );
});

test("long lines stay byte-bounded and control characters cannot reach the viewer", () => {
  const logs = buffer({ maxLineBytes: 32, maxBytes: 64 });
  logs.push("stdout", Buffer.from("A".repeat(80)));
  logs.push("stdout", "\u001b[31m\u0000\nnormal\n");
  const events = logs.replay().events;
  assert.equal(events.length, 2);
  assert.match(events[0].text, /\[truncated\]$/);
  assert.ok(Buffer.byteLength(events[0].text) <= 32);
  assert.equal(events[1].text, "normal");

  const controls = buffer();
  controls.push("stderr", "before\u001b[31m\u0000after\n");
  const text = controls.replay().events[0].text;
  assert.equal(text.includes("\u001b"), false);
  assert.equal(text.includes("\u0000"), false);
  assert.match(text, /before/);
  assert.match(text, /after/);
});

test("line and byte eviction report a replay gap without resetting sequence", () => {
  const logs = buffer({ maxLines: 3, maxBytes: 24, maxLineBytes: 16 });
  logs.push("stdout", "1111111111\n2222222222\n3333333333\n4444444444\n");
  const replay = logs.replay();
  assert.deepEqual(
    replay.events.map(({ text }) => text),
    ["3333333333", "4444444444"],
  );
  assert.deepEqual(
    replay.events.map(({ sequence }) => sequence),
    [3, 4],
  );
  assert.equal(replay.oldestSequence, 3);
  assert.equal(replay.latestSequence, 4);
  assert.equal(replay.gap, true);
  assert.equal(logs.replay(2).gap, false);
  assert.deepEqual(
    logs.replay(3).events.map(({ sequence }) => sequence),
    [4],
  );
  assert.throws(() => logs.replay(-1), RangeError);
});

test("a failing live viewer cannot interrupt stream capture", () => {
  const logs = buffer();
  const seen = [];
  const unsubscribe = logs.subscribe((event) => seen.push(event.sequence));
  logs.subscribe(() => {
    throw new Error("viewer disconnected");
  });
  logs.push("stdout", "first\nsecond\n");
  assert.deepEqual(seen, [1, 2]);
  unsubscribe();
  logs.push("stderr", "third\n");
  assert.deepEqual(seen, [1, 2]);
  assert.equal(logs.replay().latestSequence, 3);
});
