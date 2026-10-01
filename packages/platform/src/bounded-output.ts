import { PassThrough } from "node:stream";

const STREAM_HIGH_WATER_MARK = 64 * 1_024;

export interface BoundedOutputSink {
  readonly stream: PassThrough;
  readonly label: string;
  saturated: boolean;
  droppedBytes: number;
  closed: boolean;
  drainListener?: () => void;
}

export function createBoundedOutputSink(label: string): BoundedOutputSink {
  return {
    stream: new PassThrough({ highWaterMark: STREAM_HIGH_WATER_MARK }),
    label,
    saturated: false,
    droppedBytes: 0,
    closed: false,
  };
}

export function appendBoundedOutput(sink: BoundedOutputSink, chunk: Buffer): void {
  if (sink.closed) return;
  if (sink.saturated) {
    sink.droppedBytes += chunk.byteLength;
    return;
  }
  if (sink.stream.write(chunk)) return;
  sink.saturated = true;
  const onDrain = () => {
    if (sink.drainListener === onDrain) delete sink.drainListener;
    if (sink.closed) return;
    sink.saturated = false;
    const dropped = sink.droppedBytes;
    sink.droppedBytes = 0;
    if (dropped > 0) {
      appendBoundedOutput(
        sink,
        Buffer.from(`[DevDock ${sink.label} dropped ${dropped} log bytes]\n`),
      );
    }
  };
  sink.drainListener = onDrain;
  sink.stream.once("drain", onDrain);
}

export function endBoundedOutput(sink: BoundedOutputSink): void {
  if (sink.closed) return;
  sink.closed = true;
  if (sink.drainListener !== undefined) {
    sink.stream.off("drain", sink.drainListener);
    delete sink.drainListener;
  }
  sink.stream.end();
}
