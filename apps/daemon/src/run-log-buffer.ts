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

// Where the reader is inside a terminal escape sequence. Colour codes are dropped whole rather than
// shown as replacement characters, so coloured output stays readable.
type EscapeState = "none" | "escape" | "csi" | "osc" | "osc-escape";

interface StreamState {
  readonly decoder: StringDecoder;
  parts: string[];
  bytes: number;
  truncated: boolean;
  skipNextLf: boolean;
  escape: EscapeState;
  ended: boolean;
}

function newStreamState(): StreamState {
  return {
    decoder: new StringDecoder("utf8"),
    parts: [],
    bytes: 0,
    truncated: false,
    skipNextLf: false,
    escape: "none",
    ended: false,
  };
}

const LOOPBACK_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):\d{1,5}(?:\/[^\s"'<>`]*)?/iu;

// Finds the first loopback address with an explicit port in a line of output, such as Vite's
// "Local: http://localhost:5173/". Wildcard hosts become localhost, which is where a browser on this
// computer reaches them.
export function detectAppUrl(text: string): string | null {
  const match = LOOPBACK_URL.exec(text);
  if (match === null) return null;
  const candidate = match[0].replace(/[.,;:)\]}]+$/u, "");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "localhost";
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.href;
}

function positiveLimit(value: number, ceiling: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new RangeError(`${name} must be an integer between 1 and ${ceiling}`);
  }
  return value;
}

function nextEscapeState(state: EscapeState, character: string): EscapeState {
  if (state === "escape") return character === "[" ? "csi" : character === "]" ? "osc" : "none";
  if (state === "csi") {
    const point = character.codePointAt(0) ?? 0;
    return point >= 0x40 && point <= 0x7e ? "none" : "csi";
  }
  if (state === "osc") {
    return character === "\u0007" ? "none" : character === "\u001b" ? "osc-escape" : "osc";
  }
  // "osc-escape": ESC \ ends the sequence; anything else keeps reading it.
  return character === "\\" ? "none" : "osc";
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
  #appUrl: string | null = null;
  readonly #listeners = new Set<(event: LogEvent) => void>();
  readonly #streamCleanups = new Map<LogStream, () => void>();

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
    const onData = (chunk: Buffer | string) => {
      this.push(stream, chunk);
    };
    const finish = () => {
      cleanup();
      this.end(stream);
    };
    const cleanup = () => {
      source.off("data", onData);
      source.off("end", finish);
      source.off("error", finish);
      source.off("close", finish);
      if (this.#streamCleanups.get(stream) === cleanup) this.#streamCleanups.delete(stream);
    };
    this.#streamCleanups.set(stream, cleanup);
    source.on("data", onData);
    source.once("end", finish);
    source.once("error", finish);
    source.once("close", finish);
  }

  dispose(): void {
    for (const cleanup of this.#streamCleanups.values()) cleanup();
    this.#streamCleanups.clear();
    this.end("stdout");
    this.end("stderr");
    this.#listeners.clear();
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

  // The first loopback address this run printed, kept even after its line leaves the buffer.
  get appUrl(): string | null {
    return this.#appUrl;
  }

  subscribe(listener: (event: LogEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #accept(stream: LogStream, decoded: string): void {
    const state = this.#streams[stream];
    for (const character of decoded) {
      if (state.escape !== "none" && character !== "\r" && character !== "\n") {
        state.escape = nextEscapeState(state.escape, character);
        continue;
      }
      state.escape = "none";
      if (character === "\u001b") {
        state.escape = "escape";
        continue;
      }
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
    if (this.#appUrl === null) this.#appUrl = detectAppUrl(text);
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
