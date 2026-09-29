import {
  CommandPreviewResponseSchema,
  DiscoveryResponseSchema,
  OpenAppResponseSchema,
  ProjectDetailResponseSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  ServiceResponseSchema,
  SessionResponseSchema,
} from "@devdock/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiGet,
  apiPost,
  type CommandPreview,
  type Discovery,
  type Project,
  type ProjectDetail,
  safeOpenAppUrl,
} from "./api";
import { ServiceRuntimeCard } from "./ServiceRuntimeCard";

type SessionState =
  | { kind: "checking" }
  | { kind: "pairing" }
  | { kind: "ready"; csrfToken: string }
  | { kind: "error"; message: string };

function errorMessage(caught: unknown): string {
  if (caught instanceof ApiError) return `${caught.code}: ${caught.message}`;
  return "Connection failed. Check that DevDock is running, then try again.";
}

function PairingView({ onPaired }: { onPaired: (csrfToken: string) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await apiPost("/api/pair", { code: code.trim() }, (value) =>
        SessionResponseSchema.parse(value),
      );
      setCode("");
      onPaired(session.csrfToken);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="pairing-layout">
      <section className="panel pairing-panel" aria-labelledby="pairing-title">
        <span className="eyebrow">Local access</span>
        <h2 id="pairing-title">Pair this browser</h2>
        <p>Enter the one-time code printed by the DevDock terminal. The code stays in this form.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="pairing-code">Pairing code</label>
          <input
            id="pairing-code"
            type="password"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
            maxLength={128}
          />
          {error && (
            <p className="message error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" type="submit" disabled={busy || code.trim() === ""}>
            {busy ? "Pairing…" : "Pair browser"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({
  csrfToken,
  onUnauthorized,
}: {
  csrfToken: string;
  onUnauthorized: () => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [cwdInput, setCwdInput] = useState(".");
  const [discoveredCwd, setDiscoveredCwd] = useState(".");
  const [scriptName, setScriptName] = useState("");
  const [serviceName, setServiceName] = useState("");
  const [expectedPort, setExpectedPort] = useState("");
  const [previews, setPreviews] = useState<Record<string, CommandPreview>>({});
  const [openLinks, setOpenLinks] = useState<Record<string, string>>({});
  const [selectedRuntimeServiceId, setSelectedRuntimeServiceId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
      } else {
        setError(errorMessage(caught));
      }
    },
    [onUnauthorized],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh after project mutations.
  useEffect(() => {
    const controller = new AbortController();
    setProjectsLoading(true);
    void apiGet(
      "/api/projects",
      (value) => ProjectListResponseSchema.parse(value),
      controller.signal,
    )
      .then(({ projects: loaded }) => {
        if (controller.signal.aborted) return;
        setProjects(loaded);
        setSelectedId((current) =>
          current !== null && loaded.some((project) => project.id === current)
            ? current
            : (loaded[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) handleError(caught);
      })
      .finally(() => {
        if (!controller.signal.aborted) setProjectsLoading(false);
      });
    return () => controller.abort();
  }, [handleError, refresh]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Refresh after service and project mutations.
  useEffect(() => {
    setDetail(null);
    setDiscovery(null);
    setDiscoveryError(null);
    setPreviews({});
    setOpenLinks({});
    setSelectedRuntimeServiceId(null);
    if (selectedId === null) return;
    const controller = new AbortController();
    setDetailLoading(true);
    void apiGet(
      `/api/projects/${selectedId}`,
      (value) => ProjectDetailResponseSchema.parse(value),
      controller.signal,
    )
      .then((loaded) => {
        if (!controller.signal.aborted) setDetail(loaded);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) handleError(caught);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    void apiGet(
      `/api/projects/${selectedId}/scripts?cwd=${encodeURIComponent(discoveredCwd)}`,
      (value) => DiscoveryResponseSchema.parse(value),
      controller.signal,
    )
      .then(({ discovery: loaded }) => {
        if (controller.signal.aborted) return;
        setDiscovery(loaded);
        setScriptName((current) =>
          loaded.scriptNames.includes(current) ? current : (loaded.scriptNames[0] ?? ""),
        );
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else setDiscoveryError(errorMessage(caught));
      });
    return () => controller.abort();
  }, [selectedId, discoveredCwd, refresh, handleError, onUnauthorized]);

  function chooseProject(id: string) {
    setSelectedId(id);
    setCwdInput(".");
    setDiscoveredCwd(".");
    setScriptName("");
    setSelectedRuntimeServiceId(null);
    setError(null);
  }

  async function registerProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await apiPost(
        "/api/projects",
        { path: folderPath, ...(projectName.trim() ? { displayName: projectName.trim() } : {}) },
        (value) => ProjectResponseSchema.parse(value),
        csrfToken,
      );
      setFolderPath("");
      setProjectName("");
      setSelectedId(project.id);
      setRefresh((value) => value + 1);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function archiveProject() {
    if (selectedId === null) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(
        `/api/projects/${selectedId}/archive`,
        {},
        (value) => ProjectResponseSchema.parse(value),
        csrfToken,
      );
      setSelectedId(null);
      setRefresh((value) => value + 1);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function addService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedId === null || scriptName === "") return;
    const port = expectedPort.trim() === "" ? undefined : Number(expectedPort);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      setError("Expected port must be between 1 and 65535.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(
        `/api/projects/${selectedId}/services`,
        {
          scriptName,
          cwd: discoveredCwd,
          ...(serviceName.trim() ? { displayName: serviceName.trim() } : {}),
          ...(port === undefined ? {} : { expectedPort: port }),
        },
        (value) => ServiceResponseSchema.parse(value),
        csrfToken,
      );
      setServiceName("");
      setExpectedPort("");
      setRefresh((value) => value + 1);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function showPreview(serviceId: string) {
    setError(null);
    try {
      const { command } = await apiGet(`/api/services/${serviceId}/preview`, (value) =>
        CommandPreviewResponseSchema.parse(value),
      );
      setPreviews((current) => ({ ...current, [serviceId]: command }));
    } catch (caught) {
      handleError(caught);
    }
  }

  async function prepareOpenApp(serviceId: string) {
    setError(null);
    try {
      const { url } = await apiGet(`/api/services/${serviceId}/open-app`, (value) =>
        OpenAppResponseSchema.parse(value),
      );
      const safe = safeOpenAppUrl(url);
      if (safe === null) {
        setError("Open App URL is invalid.");
        return;
      }
      setOpenLinks((current) => ({ ...current, [serviceId]: safe }));
    } catch (caught) {
      handleError(caught);
    }
  }

  return (
    <main className="dashboard-grid">
      <aside className="panel sidebar" aria-label="Projects">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>Projects</h2>
          </div>
          <span className="count">{projects.length}</span>
        </div>
        {projectsLoading ? (
          <p className="muted" aria-live="polite">
            Loading projects…
          </p>
        ) : null}
        {!projectsLoading && projects.length === 0 ? (
          <p className="muted">No projects yet. Add a trusted local folder below.</p>
        ) : null}
        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`project-item ${selectedId === project.id ? "selected" : ""}`}
              onClick={() => chooseProject(project.id)}
              aria-current={selectedId === project.id ? "page" : undefined}
            >
              <strong>{project.displayName}</strong>
              <small>{project.path.displayPath}</small>
            </button>
          ))}
        </div>
        <form className="stack register-form" onSubmit={(event) => void registerProject(event)}>
          <h3>Add a project</h3>
          <label htmlFor="project-path">Folder path</label>
          <input
            id="project-path"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            placeholder="C:\\path\\to\\project"
            required
            maxLength={4096}
          />
          <label htmlFor="project-name">Display name (optional)</label>
          <input
            id="project-name"
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            maxLength={128}
          />
          <button className="primary" type="submit" disabled={busy || folderPath.trim() === ""}>
            {busy ? "Working…" : "Add project"}
          </button>
        </form>
      </aside>

      <section className="content" aria-label="Project detail">
        {error && (
          <div className="message error" role="alert">
            {error}
          </div>
        )}
        {selectedId === null ? (
          <section className="panel empty-state">
            <span className="eyebrow">Get started</span>
            <h2>Choose a project</h2>
            <p>Register a local folder to discover its npm scripts.</p>
          </section>
        ) : detailLoading ? (
          <section className="panel empty-state" aria-live="polite">
            Loading project…
          </section>
        ) : detail === null ? (
          <section className="panel empty-state">Project detail is unavailable.</section>
        ) : (
          <>
            <section className="panel project-header">
              <div>
                <span className="eyebrow">Selected project</span>
                <h2>{detail.project.displayName}</h2>
                <p className="path">{detail.project.path.displayPath}</p>
              </div>
              <button
                className="quiet danger"
                type="button"
                disabled={busy}
                onClick={() => void archiveProject()}
              >
                Archive
              </button>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">Discovery</span>
                  <h3>Choose an npm script</h3>
                </div>
              </div>
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  setDiscoveredCwd(cwdInput);
                }}
              >
                <label htmlFor="service-cwd">Working directory inside this project</label>
                <div className="inline-controls">
                  <input
                    id="service-cwd"
                    value={cwdInput}
                    onChange={(event) => setCwdInput(event.target.value)}
                    required
                    maxLength={4096}
                  />
                  <button type="submit" className="quiet">
                    Discover
                  </button>
                </div>
              </form>
              {discoveryError && (
                <p className="message error" role="alert">
                  {discoveryError}
                </p>
              )}
              {discovery && (
                <form className="stack service-form" onSubmit={(event) => void addService(event)}>
                  <p className="muted">
                    {discovery.packageName ?? "package.json"} · {discovery.scriptNames.length}{" "}
                    supported scripts
                  </p>
                  <label htmlFor="script-name">Script</label>
                  <select
                    id="script-name"
                    value={scriptName}
                    onChange={(event) => setScriptName(event.target.value)}
                    disabled={discovery.scriptNames.length === 0}
                  >
                    {discovery.scriptNames.length === 0 && (
                      <option value="">No scripts found</option>
                    )}
                    {discovery.scriptNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <div className="form-row">
                    <div className="stack">
                      <label htmlFor="service-name">Service name (optional)</label>
                      <input
                        id="service-name"
                        value={serviceName}
                        onChange={(event) => setServiceName(event.target.value)}
                        maxLength={128}
                      />
                    </div>
                    <div className="stack">
                      <label htmlFor="expected-port">App port (optional)</label>
                      <input
                        id="expected-port"
                        type="number"
                        min="1"
                        max="65535"
                        value={expectedPort}
                        onChange={(event) => setExpectedPort(event.target.value)}
                      />
                    </div>
                  </div>
                  <button className="primary" type="submit" disabled={busy || scriptName === ""}>
                    Add service
                  </button>
                </form>
              )}
            </section>

            <section className="panel">
              <span className="eyebrow">Configuration</span>
              <h3>Services</h3>
              {detail.services.length === 0 ? (
                <p className="muted">No services selected yet.</p>
              ) : null}
              <div className="service-list">
                {detail.services.map((service) => (
                  <ServiceRuntimeCard
                    key={service.id}
                    service={service}
                    csrfToken={csrfToken}
                    selected={selectedRuntimeServiceId === service.id}
                    {...(previews[service.id] === undefined
                      ? {}
                      : { preview: previews[service.id] })}
                    {...(openLinks[service.id] === undefined
                      ? {}
                      : { openLink: openLinks[service.id] })}
                    onSelect={() => setSelectedRuntimeServiceId(service.id)}
                    onPreview={() => void showPreview(service.id)}
                    onPrepareOpenApp={() => void prepareOpenApp(service.id)}
                    onUnauthorized={onUnauthorized}
                    onError={handleError}
                  />
                ))}
              </div>
            </section>

            {selectedRuntimeServiceId === null && detail.services.length > 0 ? (
              <section className="panel log-panel">
                <span className="eyebrow">Runtime</span>
                <h3>Logs and controls</h3>
                <p>Select “View runtime” on a service, or press Start to open its live log view.</p>
              </section>
            ) : null}
            {detail.services.length === 0 ? (
              <section className="panel log-panel">
                <span className="eyebrow">Runtime</span>
                <h3>Logs and controls</h3>
                <p>Add a service before starting a process.</p>
              </section>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: "checking" });
  const onUnauthorized = useCallback(() => setSession({ kind: "pairing" }), []);

  useEffect(() => {
    const controller = new AbortController();
    void apiGet("/api/session", (value) => SessionResponseSchema.parse(value), controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSession({ kind: "ready", csrfToken: result.csrfToken });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) setSession({ kind: "pairing" });
        else setSession({ kind: "error", message: errorMessage(caught) });
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <div>
            <span className="eyebrow">Local developer workspace</span>
            <h1>DevDock</h1>
          </div>
        </div>
        <span className="local-badge">LOCAL · 127.0.0.1</span>
      </header>
      {session.kind === "checking" && (
        <main className="center-state" aria-live="polite">
          Checking session…
        </main>
      )}
      {session.kind === "error" && (
        <main className="center-state" role="alert">
          {session.message}{" "}
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </main>
      )}
      {session.kind === "pairing" && (
        <PairingView onPaired={(csrfToken) => setSession({ kind: "ready", csrfToken })} />
      )}
      {session.kind === "ready" && (
        <Dashboard csrfToken={session.csrfToken} onUnauthorized={onUnauthorized} />
      )}
    </div>
  );
}
