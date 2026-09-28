import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { type LogEvent, LogEventSchema } from "@devdock/contracts";

const DEFAULT_MAX_LINES = 5_000;
const DEFAULT_MAX_BYTES = 5 * 1_024 * 1_024;
const DEFAULT_MAX_LINE_BYTES = 16 * 1_024;
const TRUNCATION_MARKER = "… [truncated]";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

export type LogStream = "stdout" | "stderr";

export interface LogBufferOptions {
  maxLines?: number;
  maxBytes?: number;
  maxLineBytes?: number;
  now?: () => Date;
}

export interface LogReplay {
  readonly events: readonly LogEvent[];
  readonly gap: boolean;
  readonly oldestSequence: number;
  readonly latestSequence: number;
}

interface StreamState {
  readonly decoder: StringDecoder;
  parts: string[];
  bytes: number;
  truncated: boolean;
  skipNextLf: boolean;
  ended: boolean;
}

function newStreamState(): StreamState {
  return {
    decoder: new StringDecoder("utf8"),
    parts: [],
    bytes: 0,
    truncated: false,
    skipNextLf: false,
    ended: false,
  };
}

function positiveLimit(value: number, ceiling: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function safeCharacter(character: string): string {
  const point = character.codePointAt(0);
  if (point === undefined) return "";
  if ((point < 32 && character !== "\t") || point === 127 || (point >= 128 && point <= 159)) {
    return "�";
  }
  return character;
}

export class RunLogBuffer {
  readonly daemonSessionId: string;
  readonly runId: string;
  readonly #maxLines: number;
  readonly #maxBytes: number;
  readonly #maxLineBytes: number;
  readonly #now: () => Date;
  readonly #streams: Record<LogStream, StreamState> = {
    stdout: newStreamState(),
    stderr: newStreamState(),
  };
  #entries: Array<{ event: LogEvent; bytes: number }> = [];
  #head = 0;
  #retainedBytes = 0;
  #sequence = 0;
  #capturing = false;
  readonly #listeners = new Set<(event: LogEvent) => void>();

  constructor(daemonSessionId: string, runId: string, options: LogBufferOptions = {}) {
    this.daemonSessionId = daemonSessionId;
    this.runId = runId;
    this.#maxLines = positiveLimit(
      options.maxLines ?? DEFAULT_MAX_LINES,
      DEFAULT_MAX_LINES,
      "maxLines",
    );
    this.#maxBytes = positiveLimit(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      "maxBytes",
    );
    this.#maxLineBytes = positiveLimit(
      options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      DEFAULT_MAX_LINE_BYTES,
      "maxLineBytes",
    );
    if (this.#maxLineBytes < TRUNCATION_MARKER_BYTES || this.#maxBytes < this.#maxLineBytes) {
      throw new RangeError("Log byte limits must fit one line and its truncation marker");
    }
    this.#now = options.now ?? (() => new Date());
    // Validate stable identifiers before any stream is attached.
    LogEventSchema.parse({
      daemonSessionId,
      runId,
      sequence: 1,
      timestamp: this.#now().toISOString(),
      type: "log",
      stream: "stdout",
      text: "",
    });
  }

  capture(stdout: Readable, stderr: Readable): void {
    if (this.#capturing) throw new Error("Run log streams are already attached");
    this.#capturing = true;
    this.#captureStream("stdout", stdout);
    this.#captureStream("stderr", stderr);
  }

  #captureStream(stream: LogStream, source: Readable): void {
    source.on("data", (chunk: Buffer | string) => {
      this.push(stream, chunk);
    });
    source.once("end", () => this.end(stream));
    source.once("error", () => this.end(stream));
    source.once("close", () => this.end(stream));
  }

  push(stream: LogStream, chunk: Buffer | string): void {
    const state = this.#streams[stream];
    if (state.ended) throw new Error(`${stream} log stream has ended`);
    const decoded = state.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    this.#accept(stream, decoded);
  }

  end(stream: LogStream): void {
    const state = this.#streams[stream];
    if (state.ended) return;
    this.#accept(stream, state.decoder.end());
    if (state.parts.length > 0 || state.truncated) this.#emit(stream);
    state.ended = true;
  }

  replay(afterSequence = 0): LogReplay {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new RangeError("afterSequence must be a non-negative safe integer");
    }
    const oldestSequence = this.#entries[this.#head]?.event.sequence ?? this.#sequence + 1;
    return {
      events: this.#entries
        .slice(this.#head)
        .map(({ event }) => event)
        .filter((event) => event.sequence > afterSequence),
      gap: afterSequence < oldestSequence - 1,
      oldestSequence,
      latestSequence: this.#sequence,
    };
  }

  subscribe(listener: (event: LogEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #accept(stream: LogStream, decoded: string): void {
    const state = this.#streams[stream];
    for (const character of decoded) {
      if (state.skipNextLf) {
        state.skipNextLf = false;
        if (character === "\n") continue;
      }
      if (character === "\r" || character === "\n") {
        this.#emit(stream);
        if (character === "\r") state.skipNextLf = true;
        continue;
      }
      if (state.truncated) continue;
      const safe = safeCharacter(character);
      const bytes = Buffer.byteLength(safe, "utf8");
      if (state.bytes + bytes <= this.#maxLineBytes) {
        state.parts.push(safe);
        state.bytes += bytes;
        continue;
      }
      while (state.bytes + TRUNCATION_MARKER_BYTES > this.#maxLineBytes) {
        const removed = state.parts.pop();
        if (removed === undefined) break;
        state.bytes -= Buffer.byteLength(removed, "utf8");
      }
      state.parts.push(TRUNCATION_MARKER);
      state.bytes += TRUNCATION_MARKER_BYTES;
      state.truncated = true;
    }
  }

  #emit(stream: LogStream): void {
    const state = this.#streams[stream];
    const text = state.parts.join("");
    const event = Object.freeze(
      LogEventSchema.parse({
        daemonSessionId: this.daemonSessionId,
        runId: this.runId,
        sequence: ++this.#sequence,
        timestamp: this.#now().toISOString(),
        type: "log",
        stream,
        text,
      }),
    );
    this.#entries.push({ event, bytes: state.bytes });
    this.#retainedBytes += state.bytes;
    state.parts = [];
    state.bytes = 0;
    state.truncated = false;
    while (
      this.#entries.length - this.#head > this.#maxLines ||
      this.#retainedBytes > this.#maxBytes
    ) {
      const removed = this.#entries[this.#head];
      if (removed === undefined) break;
      this.#retainedBytes -= removed.bytes;
      this.#head += 1;
    }
    if (this.#head >= 1_024 && this.#head * 2 >= this.#entries.length) {
      this.#entries = this.#entries.slice(this.#head);
      this.#head = 0;
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected viewer must never stop draining a service's stdout/stderr.
        this.#listeners.delete(listener);
      }
    }
  }
}
