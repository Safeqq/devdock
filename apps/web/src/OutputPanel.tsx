import { type LogEvent, LogEventSchema, LogGapEventSchema } from "@devdock/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { Tone } from "./status";

const MAX_RENDERED_LINES = 1_000;
const FLUSH_MS = 60;

export interface OutputTab {
  readonly serviceId: string;
  readonly title: string;
  readonly runId: string;
  readonly tone: Tone;
  // How the run ended, shown under its last line; null while it is still going.
  readonly ending: string | null;
}

function clock(iso: string): string {
  const date = new Date(iso);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

// Output of one run, streamed from the daemon. Only the visible tab holds a connection.
function useRunOutput(runId: string | null) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLines([]);
    setNotice(null);
    if (runId === null) return;
    // Bursts arrive as many small events; render them together instead of one by one.
    let pending: LogEvent[] = [];
    let timer: number | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = [];
      setLines((current) => [...current, ...batch].slice(-MAX_RENDERED_LINES));
    };
    const source = new EventSource(`/api/events?runId=${encodeURIComponent(runId)}`, {
      withCredentials: true,
    });
    source.addEventListener("log", (event) => {
      try {
        const parsed = LogEventSchema.parse(JSON.parse(event.data));
        if (parsed.runId !== runId) return;
        pending.push(parsed);
        timer ??= window.setTimeout(flush, FLUSH_MS);
      } catch {
        setNotice("Some output could not be shown.");
      }
    });
    source.addEventListener("gap", (event) => {
      try {
        LogGapEventSchema.parse(JSON.parse(event.data));
        setNotice("Older lines were dropped to save memory; only the newest output is kept.");
      } catch {
        setNotice("Some output could not be shown.");
      }
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setNotice("The output of this run is no longer available.");
      }
    };
    return () => {
      source.close();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runId]);

  return { lines, notice };
}

export function OutputPanel({
  tabs,
  selectedId,
  onSelect,
}: {
  tabs: readonly OutputTab[];
  selectedId: string | null;
  onSelect: (serviceId: string) => void;
}) {
  const selected = tabs.find((tab) => tab.serviceId === selectedId) ?? tabs[0] ?? null;
  const { lines, notice } = useRunOutput(selected?.runId ?? null);
  const [clearedThrough, setClearedThrough] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const followTail = useRef(true);

  const visible =
    selected === null
      ? []
      : lines.filter((line) => line.sequence > (clearedThrough[selected.runId] ?? 0));

  // Keep the newest line in view unless the user scrolled up to read something.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll whenever lines change.
  useEffect(() => {
    const element = scroller.current;
    if (element !== null && followTail.current) element.scrollTop = element.scrollHeight;
  }, [visible.length, selected?.ending]);

  useEffect(() => {
    if (copied === null) return;
    const timer = window.setTimeout(() => setCopied(null), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (selected === null) {
    return (
      <section className="output empty" aria-label="Script output">
        <Icon name="terminal" />
        <p>Output from your scripts will appear here once you start one.</p>
      </section>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(visible.map((line) => line.text).join("\n"));
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <section className="output" aria-label="Script output">
      <div className="output-head">
        <div className="tabs" role="tablist" aria-label="Scripts with output">
          {tabs.map((tab) => (
            <button
              key={tab.serviceId}
              className={tab === selected ? "tab active" : "tab"}
              type="button"
              role="tab"
              aria-selected={tab === selected}
              onClick={() => {
                followTail.current = true;
                onSelect(tab.serviceId);
              }}
            >
              <span className={`dot ${tab.tone}`} aria-hidden="true" />
              {tab.title}
            </button>
          ))}
        </div>
        <div className="tools">
          <button
            className="btn ghost tiny"
            type="button"
            onClick={() => void copy()}
            disabled={visible.length === 0}
          >
            <Icon name="copy" />
            {copied === "done" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
          </button>
          <button
            className="btn ghost tiny"
            type="button"
            disabled={visible.length === 0}
            onClick={() =>
              setClearedThrough((current) => ({
                ...current,
                [selected.runId]: lines.at(-1)?.sequence ?? 0,
              }))
            }
            title="Clears this view only; the script keeps running"
          >
            Clear
          </button>
        </div>
      </div>
      <div
        className="log"
        ref={scroller}
        role="tabpanel"
        onScroll={(event) => {
          const element = event.currentTarget;
          followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {notice === null ? null : <p className="log-note">{notice}</p>}
        {visible.length === 0 && selected.ending === null ? (
          <p className="log-note">Waiting for output…</p>
        ) : null}
        <ol aria-label={`${selected.title} output`}>
          {visible.map((line) => (
            <li key={line.sequence} className={line.stream}>
              <span className="t">{clock(line.timestamp)}</span>
              <span className="text">{line.text === "" ? " " : line.text}</span>
            </li>
          ))}
        </ol>
        {selected.ending === null ? null : (
          <p className={`log-end ${selected.tone}`}>{selected.ending}</p>
        )}
      </div>
    </section>
  );
}
