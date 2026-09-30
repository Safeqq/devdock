import {
  type LogEvent,
  LogEventSchema,
  LogGapEventSchema,
  type RunSnapshot,
  type ServiceConfig,
  type ServiceDiagnosticsResponse,
  ServiceDiagnosticsResponseSchema,
  ServiceRuntimeStatusResponseSchema,
  ServiceStartResponseSchema,
  ServiceStopResponseSchema,
} from "@devdock/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost, type CommandPreview } from "./api";

const MAX_RENDERED_LOGS = 500;

type Ownership = "owned" | "exited" | "unknown" | null;
type RuntimeStatus = { snapshot: RunSnapshot | null; ownership: Ownership };
type RuntimeAction = "start" | "stop" | "refresh" | "diagnostics";
type LogConnection = "idle" | "connecting" | "live" | "disconnected";

interface ServiceRuntimeCardProps {
  readonly service: ServiceConfig;
  readonly csrfToken: string;
  readonly selected: boolean;
  readonly preview?: CommandPreview;
  readonly openLink?: string;
  readonly onSelect: () => void;
  readonly onPreview: () => void;
  readonly onPrepareOpenApp: () => void;
  readonly onUnauthorized: () => void;
  readonly onError: (caught: unknown) => void;
}

function runtimeError(caught: unknown): string {
  if (caught instanceof ApiError) return `${caught.code}: ${caught.message}`;
  return "Runtime status is unavailable.";
}

function diagnosticsErrorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return `${caught.code}: ${caught.message}`;
  return "Diagnostics are unavailable.";
}

function diagnosticLabel(status: string): string {
  return status
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function processLabel(status: RuntimeStatus | null): string {
  if (status === null) return "Loading";
  if (status.snapshot === null) return "Stopped";
  const state = status.snapshot.processState;
  return `${state.slice(0, 1).toUpperCase()}${state.slice(1)}`;
}

function terminal(snapshot: RunSnapshot | null): boolean {
  return (
    snapshot === null ||
    snapshot.processState === "stopped" ||
    snapshot.processState === "exited" ||
    snapshot.processState === "failed"
  );
}

export function ServiceRuntimeCard({
  service,
  csrfToken,
  selected,
  preview,
  openLink,
  onSelect,
  onPreview,
  onPrepareOpenApp,
  onUnauthorized,
  onError,
}: ServiceRuntimeCardProps) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RuntimeAction | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [logConnection, setLogConnection] = useState<LogConnection>("idle");
  const [logError, setLogError] = useState<string | null>(null);
  const [gapMessage, setGapMessage] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ServiceDiagnosticsResponse | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  const refreshStatus = useCallback(
    async (signal?: AbortSignal) => {
      setStatusError(null);
      try {
        const loaded = await apiGet(
          `/api/services/${service.id}/status`,
          (value) => ServiceRuntimeStatusResponseSchema.parse(value),
          signal,
        );
        if (!signal?.aborted) setStatus(loaded);
      } catch (caught) {
        if (signal?.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else setStatusError(runtimeError(caught));
      }
    },
    [onUnauthorized, service.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refreshStatus(controller.signal);
    return () => controller.abort();
  }, [refreshStatus]);

  const readinessChecking = status?.snapshot?.readinessState === "checking";
  useEffect(() => {
    if (!readinessChecking) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = () => {
      timer = window.setTimeout(() => {
        void refreshStatus(controller.signal).finally(() => {
          if (!controller.signal.aborted) poll();
        });
      }, 250);
    };
    poll();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      controller.abort();
    };
  }, [readinessChecking, refreshStatus]);

  const runId = status?.snapshot?.runId ?? null;
  useEffect(() => {
    if (!selected || runId === null) {
      setLogConnection("idle");
      return;
    }
    setLogs([]);
    setGapMessage(null);
    setLogError(null);
    setLogConnection("connecting");
    const source = new EventSource(`/api/events?runId=${encodeURIComponent(runId)}`, {
      withCredentials: true,
    });
    source.onopen = () => setLogConnection("live");
    source.onerror = () => setLogConnection("disconnected");
    source.addEventListener("log", (event) => {
      try {
        const parsed = LogEventSchema.parse(JSON.parse(event.data));
        if (parsed.runId !== runId) throw new Error("Run ID mismatch");
        setLogs((current) => [...current, parsed].slice(-MAX_RENDERED_LOGS));
      } catch {
        setLogError("A log event from the daemon was invalid.");
      }
    });
    source.addEventListener("gap", (event) => {
      try {
        const parsed = LogGapEventSchema.parse(JSON.parse(event.data));
        if (parsed.runId !== runId) throw new Error("Run ID mismatch");
        setGapMessage(
          `Earlier logs are unavailable. Retained sequence starts at ${parsed.oldestSequence}.`,
        );
      } catch {
        setLogError("A log gap event from the daemon was invalid.");
      }
    });
    return () => source.close();
  }, [runId, selected]);

  async function start() {
    onSelect();
    setBusy("start");
    setStatusError(null);
    try {
      const { outcome } = await apiPost(
        `/api/services/${service.id}/start`,
        {},
        (value) => ServiceStartResponseSchema.parse(value),
        csrfToken,
      );
      setStatus({ snapshot: outcome.snapshot, ownership: "owned" });
    } catch (caught) {
      onError(caught);
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy("stop");
    setStatusError(null);
    try {
      const { outcome } = await apiPost(
        `/api/services/${service.id}/stop`,
        {},
        (value) => ServiceStopResponseSchema.parse(value),
        csrfToken,
      );
      setStatus({ snapshot: outcome.snapshot, ownership: null });
    } catch (caught) {
      onError(caught);
      await refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy("refresh");
    await refreshStatus();
    setBusy(null);
  }

  async function runDiagnostics() {
    setBusy("diagnostics");
    setDiagnosticsError(null);
    setDiagnostics(null);
    try {
      const loaded = await apiGet(`/api/services/${service.id}/diagnostics`, (value) =>
        ServiceDiagnosticsResponseSchema.parse(value),
      );
      setDiagnostics(loaded);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setDiagnosticsError(diagnosticsErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const snapshot = status?.snapshot ?? null;
  const blocked = snapshot?.reconciliationState === "unknown" || status?.ownership === "unknown";
  const canStart = status !== null && statusError === null && terminal(snapshot) && !blocked;
  const canStop = status?.ownership === "owned" && !terminal(snapshot);

  return (
    <article className={`service-card ${selected ? "runtime-selected" : ""}`}>
      <div className="service-title">
        <div>
          <h4>{service.displayName}</h4>
          <p className="muted">
            npm run {service.scriptName}
            {service.expectedPort ? ` · port ${service.expectedPort}` : ""}
            {service.readiness
              ? ` · ${service.readiness.kind.toUpperCase()} readiness (${service.readiness.timeoutMs} ms)`
              : ""}
          </p>
        </div>
        <span className={`status-chip state-${snapshot?.processState ?? "stopped"}`}>
          {statusError === null ? processLabel(status) : "Unavailable"}
        </span>
      </div>

      {statusError && (
        <p className="message error compact" role="alert">
          {statusError}
        </p>
      )}
      {blocked && (
        <p className="message warning compact">
          Ownership is unknown. Start and Stop stay blocked until the run is reconciled.
        </p>
      )}
      {snapshot?.failureReason && !blocked ? (
        <p className="message error compact">{diagnosticLabel(snapshot.failureReason)}</p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={busy !== null || !canStart}
          onClick={() => void start()}
          aria-label={`Start ${service.displayName}`}
        >
          {busy === "start" ? "Starting…" : "Start"}
        </button>
        <button
          type="button"
          className="quiet danger"
          disabled={busy !== null || !canStop}
          onClick={() => void stop()}
          aria-label={`Stop ${service.displayName}`}
        >
          {busy === "stop" ? "Stopping…" : "Stop"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy !== null}
          onClick={() => void refresh()}
          aria-label={`Refresh ${service.displayName} status`}
        >
          {busy === "refresh" ? "Refreshing…" : "Refresh status"}
        </button>
        <button type="button" className="quiet" onClick={onSelect} aria-pressed={selected}>
          {selected ? "Viewing runtime" : "View runtime"}
        </button>
        <button type="button" className="quiet" onClick={onPreview}>
          View command
        </button>
        <button
          type="button"
          className="quiet"
          disabled={busy !== null}
          onClick={() => void runDiagnostics()}
          aria-label={`Run ${service.displayName} diagnostics`}
        >
          {busy === "diagnostics" ? "Checking…" : "Run diagnostics"}
        </button>
        <button type="button" className="quiet" onClick={onPrepareOpenApp}>
          Prepare Open App
        </button>
        {openLink && (
          <a className="button-link" href={openLink} target="_blank" rel="noopener noreferrer">
            Open App ↗
          </a>
        )}
      </div>

      {snapshot && (
        <dl className="runtime-facts">
          <div>
            <dt>Run</dt>
            <dd>{snapshot.runId}</dd>
          </div>
          <div>
            <dt>PID</dt>
            <dd>{snapshot.pid ?? "—"}</dd>
          </div>
          <div>
            <dt>Readiness</dt>
            <dd>{diagnosticLabel(snapshot.readinessState)}</dd>
          </div>
          <div>
            <dt>Ownership</dt>
            <dd>{status?.ownership ?? "none"}</dd>
          </div>
        </dl>
      )}

      {preview && (
        <div className="preview">
          <strong>Command preview</strong>
          <pre>{JSON.stringify(preview, null, 2)}</pre>
        </div>
      )}

      {diagnosticsError && (
        <p className="message error compact" role="alert">
          {diagnosticsError}
        </p>
      )}

      {diagnostics && (
        <section className="diagnostics-view" aria-label={`${service.displayName} diagnostics`}>
          <div className="runtime-heading">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h4>Configuration checks</h4>
            </div>
            <span
              className={`diagnostic-state ${
                diagnostics.environment.allRequiredKeysPresent ? "pass" : "attention"
              }`}
            >
              {diagnostics.environment.keys.length === 0
                ? "No required keys"
                : diagnostics.environment.allRequiredKeysPresent
                  ? "Keys present"
                  : "Keys missing"}
            </span>
          </div>
          <dl className="diagnostic-facts">
            <div>
              <dt>Expected port</dt>
              <dd>
                {diagnosticLabel(diagnostics.port.status)}
                {"port" in diagnostics.port ? ` · ${diagnostics.port.port}` : ""}
              </dd>
            </div>
            <div>
              <dt>Port action</dt>
              <dd>Advisory only</dd>
            </div>
          </dl>
          {diagnostics.environment.files.length > 0 ? (
            <ul className="diagnostic-list" aria-label="Environment files">
              {diagnostics.environment.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>
                  <span>{diagnosticLabel(file.status)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted diagnostic-empty">No environment files configured.</p>
          )}
          {diagnostics.environment.keys.length > 0 ? (
            <ul className="diagnostic-list" aria-label="Required environment keys">
              {diagnostics.environment.keys.map((key) => (
                <li key={key.name}>
                  <code>{key.name}</code>
                  <span className={key.present ? "diagnostic-pass" : "diagnostic-attention"}>
                    {key.present ? "Present" : "Missing"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted diagnostic-empty">No required environment keys configured.</p>
          )}
          <p className="diagnostic-note">
            Values stay in the daemon and are never included in this response.
          </p>
        </section>
      )}

      {selected && (
        <section className="runtime-view" aria-label={`${service.displayName} runtime`}>
          <div className="runtime-heading">
            <div>
              <span className="eyebrow">Runtime</span>
              <h4>Logs</h4>
            </div>
            <span className={`connection-state ${logConnection}`}>{logConnection}</span>
          </div>
          {runId === null ? (
            <p className="muted">Logs become available after this service starts.</p>
          ) : null}
          {gapMessage && <p className="message warning compact">{gapMessage}</p>}
          {logError && (
            <p className="message error compact" role="alert">
              {logError}
            </p>
          )}
          {runId !== null && logs.length === 0 ? (
            <p className="muted" aria-live="polite">
              Waiting for output…
            </p>
          ) : null}
          {logs.length > 0 && (
            <ol className="log-lines" aria-label={`${service.displayName} logs`}>
              {logs.map((event) => (
                <li key={event.sequence}>
                  <span className={`log-stream ${event.stream}`}>{event.stream}</span>
                  <code>{event.text || " "}</code>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </article>
  );
}
