import {
  type ServiceDiagnosticsResponse,
  ServiceDiagnosticsResponseSchema,
  ServiceResponseSchema,
} from "@devdock/contracts";
import { type FormEvent, useState } from "react";
import { ApiError, apiGet, apiPost, friendlyError, type Service, type SystemInfo } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";
import type { ScriptEntry } from "./ScriptCard";

type ReadyWhen = "none" | "tcp" | "http";

function list(value: string): string[] {
  return value
    .split(/[\r\n,]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const fileStatus: Record<string, string> = {
  loaded: "Found",
  missing: "Missing",
  unreadable: "Can't be read",
  invalid: "Not a valid .env file",
  too_large: "Too large",
  outside_cwd: "Outside the project",
};

export function nodeLabel(system: SystemInfo | null): string {
  if (system === null) return "Node.js";
  const version = system.projectNode.version?.replace(/^v/u, "");
  return version === undefined ? "Node.js" : `Node.js ${version}`;
}

// Optional settings for one script, in plain words. Every field may stay empty.
export function ScriptSettings({
  entry,
  projectId,
  projectPath,
  system,
  running,
  csrfToken,
  onClose,
  onSaved,
  onUnauthorized,
}: {
  entry: ScriptEntry;
  projectId: string;
  projectPath: string;
  system: SystemInfo | null;
  running: boolean;
  csrfToken: string;
  onClose: () => void;
  onSaved: (service: Service) => void;
  onUnauthorized: () => void;
}) {
  const service = entry.service;
  const [port, setPort] = useState(service?.expectedPort?.toString() ?? "");
  const [readyWhen, setReadyWhen] = useState<ReadyWhen>(service?.readiness?.kind ?? "none");
  const [readyPath, setReadyPath] = useState(
    service?.readiness?.kind === "http" ? service.readiness.path : "/",
  );
  const [timeout, setTimeoutSeconds] = useState(
    String(Math.round((service?.readiness?.timeoutMs ?? 30_000) / 1_000)),
  );
  const [envFiles, setEnvFiles] = useState(service?.envFiles.join(", ") ?? "");
  const [requiredKeys, setRequiredKeys] = useState(service?.requiredEnvKeys.join(", ") ?? "");
  const [restart, setRestart] = useState(service?.restartPolicy.kind ?? "off");
  const [attempts, setAttempts] = useState(
    String(service?.restartPolicy.kind === "on_failure" ? service.restartPolicy.maxAttempts : 2),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [diagnostics, setDiagnostics] = useState<ServiceDiagnosticsResponse | null>(null);

  function validate() {
    const found: Record<string, string> = {};
    const portNumber = port.trim() === "" ? undefined : Number(port);
    if (
      portNumber !== undefined &&
      (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535)
    ) {
      found.port = "Use a whole number from 1 to 65535.";
    }
    if (readyWhen !== "none" && portNumber === undefined && found.port === undefined) {
      found.port = "Add the port first — DevDock checks it to know when your app is ready.";
    }
    const seconds = Number(timeout);
    if (readyWhen !== "none" && (!Number.isInteger(seconds) || seconds < 1 || seconds > 60)) {
      found.timeout = "Choose 1 to 60 seconds.";
    }
    if (readyWhen === "http" && (!readyPath.startsWith("/") || readyPath.startsWith("//"))) {
      found.path = "The page must start with /, for example /health.";
    }
    const tries = Number(attempts);
    if (restart === "on_failure" && (!Number.isInteger(tries) || tries < 1 || tries > 10)) {
      found.attempts = "Choose 1 to 10 times.";
    }
    const keys = list(requiredKeys);
    if (keys.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))) {
      found.keys = "Use variable names only, such as DATABASE_URL — never their values.";
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return null;
    const previous = service?.restartPolicy.kind === "on_failure" ? service.restartPolicy : null;
    return {
      ...(portNumber === undefined ? {} : { expectedPort: portNumber }),
      ...(readyWhen === "tcp" ? { readiness: { kind: "tcp", timeoutMs: seconds * 1_000 } } : {}),
      ...(readyWhen === "http"
        ? { readiness: { kind: "http", path: readyPath, timeoutMs: seconds * 1_000 } }
        : {}),
      restartPolicy:
        restart === "off"
          ? { kind: "off" }
          : {
              kind: "on_failure",
              maxAttempts: tries,
              initialBackoffMs: previous?.initialBackoffMs ?? 1_000,
              maxBackoffMs: previous?.maxBackoffMs ?? 10_000,
            },
      envFiles: list(envFiles),
      requiredEnvKeys: keys,
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const settings = validate();
    if (settings === null) return;
    setSaving(true);
    setError(null);
    try {
      const { service: saved } =
        service === null
          ? await apiPost(
              `/api/projects/${projectId}/services`,
              { scriptName: entry.scriptName, ...settings },
              (value) => ServiceResponseSchema.parse(value),
              csrfToken,
            )
          : await apiPost(
              `/api/services/${service.id}/settings`,
              settings,
              (value) => ServiceResponseSchema.parse(value),
              csrfToken,
            );
      onSaved(saved);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
      setSaving(false);
    }
  }

  async function check() {
    if (service === null) return;
    setChecking(true);
    setError(null);
    try {
      setDiagnostics(
        await apiGet(`/api/services/${service.id}/diagnostics`, (value) =>
          ServiceDiagnosticsResponseSchema.parse(value),
        ),
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
    } finally {
      setChecking(false);
    }
  }

  const problem = (key: string) =>
    problems[key] === undefined ? null : (
      <small className="field-error" role="alert">
        {problems[key]}
      </small>
    );

  return (
    <Dialog onClose={onClose} labelledBy="settings-title" variant="sheet">
      <form className="sheet-form" onSubmit={(event) => void save(event)} noValidate>
        <header className="sheet-head">
          <div>
            <p className="eyebrow">Script settings</p>
            <h2 id="settings-title" className="sheet-title">
              <code>{entry.title}</code>
            </h2>
          </div>
          <button
            className="btn icon-only ghost"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" />
          </button>
        </header>
        <div className="sheet-scroll">
          <p className="hint">
            All optional. They help DevDock tell when your app is ready and how to open it.
            {running ? " Changes apply the next time this script starts." : ""}
          </p>

          <section className="group-box" aria-labelledby="settings-open">
            <h3 id="settings-open">Opening your app</h3>
            <div className="field">
              <label htmlFor="setting-port">Port</label>
              <input
                id="setting-port"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                placeholder="e.g. 3000"
                aria-invalid={problems.port !== undefined}
                aria-describedby="setting-port-help"
              />
              {problem("port")}
              <small id="setting-port-help">
                The number in your app's address, e.g. <code>localhost:3000</code>. Leave it empty
                and DevDock will try to spot the address in the output.
              </small>
            </div>
          </section>

          <fieldset className="group-box">
            <legend>When is it ready?</legend>
            <label className="radio">
              <input
                type="radio"
                name="ready"
                checked={readyWhen === "none"}
                onChange={() => setReadyWhen("none")}
              />
              As soon as it starts
            </label>
            <label className="radio">
              <input
                type="radio"
                name="ready"
                checked={readyWhen === "tcp"}
                onChange={() => setReadyWhen("tcp")}
              />
              When the port starts answering
            </label>
            <label className="radio">
              <input
                type="radio"
                name="ready"
                checked={readyWhen === "http"}
                onChange={() => setReadyWhen("http")}
              />
              When this page loads:
              <input
                className="inline"
                value={readyPath}
                onChange={(event) => setReadyPath(event.target.value)}
                onFocus={() => setReadyWhen("http")}
                aria-label="Page that shows it is ready"
                aria-invalid={problems.path !== undefined}
              />
            </label>
            {problem("path")}
            {readyWhen === "none" ? null : (
              <small>
                Give up after{" "}
                <input
                  className="inline short"
                  inputMode="numeric"
                  value={timeout}
                  onChange={(event) => setTimeoutSeconds(event.target.value)}
                  aria-label="Seconds to wait before giving up"
                  aria-invalid={problems.timeout !== undefined}
                />{" "}
                seconds and show it as failed.
              </small>
            )}
            {problem("timeout")}
          </fieldset>

          <section className="group-box" aria-labelledby="settings-env">
            <h3 id="settings-env">Environment</h3>
            <div className="field">
              <label htmlFor="setting-env-files">Files to load</label>
              <input
                id="setting-env-files"
                value={envFiles}
                onChange={(event) => setEnvFiles(event.target.value)}
                placeholder=".env.local"
                spellCheck={false}
                aria-describedby="setting-env-files-help"
              />
              <small id="setting-env-files-help">
                Separate several with commas. Values stay on this computer and are never shown in
                DevDock.
              </small>
            </div>
            <div className="field">
              <label htmlFor="setting-env-keys">Variables it needs</label>
              <input
                id="setting-env-keys"
                value={requiredKeys}
                onChange={(event) => setRequiredKeys(event.target.value)}
                placeholder="DATABASE_URL, API_KEY"
                spellCheck={false}
                aria-invalid={problems.keys !== undefined}
                aria-describedby="setting-env-keys-help"
              />
              {problem("keys")}
              <small id="setting-env-keys-help">
                Names only. DevDock won't start the script if one is missing.
              </small>
            </div>
          </section>

          <fieldset className="group-box">
            <legend>If it crashes</legend>
            <label className="radio">
              <input
                type="radio"
                name="restart"
                checked={restart === "off"}
                onChange={() => setRestart("off")}
              />
              Leave it stopped so I can look
            </label>
            <label className="radio">
              <input
                type="radio"
                name="restart"
                checked={restart === "on_failure"}
                onChange={() => setRestart("on_failure")}
              />
              Restart it, up to
              <input
                className="inline short"
                inputMode="numeric"
                value={attempts}
                onChange={(event) => setAttempts(event.target.value)}
                onFocus={() => setRestart("on_failure")}
                aria-label="Restart attempts"
                aria-invalid={problems.attempts !== undefined}
              />
              times
            </label>
            {problem("attempts")}
          </fieldset>

          <section className="group-box" aria-labelledby="settings-check">
            <h3 id="settings-check">Check before starting</h3>
            {service === null ? (
              <small>Save these settings first, then DevDock can check them.</small>
            ) : (
              <>
                <button
                  className="btn ghost tiny"
                  type="button"
                  onClick={() => void check()}
                  disabled={checking}
                >
                  {checking ? "Checking…" : "Check port and environment"}
                </button>
                {diagnostics === null ? null : (
                  <ul className="checks" aria-label="Check results">
                    <li>
                      <span>Port</span>
                      <span>
                        {diagnostics.port.status === "not_configured"
                          ? "Not set"
                          : diagnostics.port.status === "available"
                            ? `${diagnostics.port.port} is free`
                            : diagnostics.port.status === "in_use"
                              ? `${diagnostics.port.port} is in use${running ? " (probably by this script)" : " by another program"}`
                              : `${diagnostics.port.port}: couldn't tell`}
                      </span>
                    </li>
                    {diagnostics.environment.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code>
                        <span className={file.status === "loaded" ? "ok" : "bad"}>
                          {fileStatus[file.status] ?? file.status}
                        </span>
                      </li>
                    ))}
                    {diagnostics.environment.keys.map((key) => (
                      <li key={key.name}>
                        <code>{key.name}</code>
                        <span className={key.present ? "ok" : "bad"}>
                          {key.present ? "Present" : "Missing"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <div className="preview">
            <span className="eyebrow">What DevDock runs</span>
            <code>npm run {entry.scriptName}</code>
            <small>
              in {entry.location ?? projectPath} with {nodeLabel(system)}
              {system?.projectNode.source === "daemon" ? " (built into DevDock)" : ""}
            </small>
          </div>
          {error === null ? null : (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions sheet-actions">
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
