import {
  ProjectListResponseSchema,
  RuntimeSummaryResponseSchema,
  SystemInfoResponseSchema,
} from "@devdock/contracts";
import { useCallback, useEffect, useState } from "react";
import { AddProjectDialog } from "./AddProjectDialog";
import { ApiError, apiGet, friendlyError, type Project, type SystemInfo } from "./api";
import { isDesktop, pickFolder } from "./desktop";
import { Icon, Logo } from "./icons";
import { ProjectView } from "./ProjectView";
import { nodeLabel } from "./ScriptSettings";
import { HowItWorksDialog, Welcome } from "./Welcome";

const SUMMARY_POLL_MS = 3_000;
const SELECTED_KEY = "devdock.selectedProject";

type Counts = { active: number; failed: number };
type Modal = { kind: "add"; path: string | null } | { kind: "help" } | null;

function projectStatus(counts: Counts | undefined) {
  if (counts === undefined || (counts.active === 0 && counts.failed === 0)) {
    return { dot: "", text: "Nothing running", tone: "" };
  }
  if (counts.active > 0) {
    return { dot: "ready", text: `${counts.active} running`, tone: "ok" };
  }
  return { dot: "failed", text: `${counts.failed} failed`, tone: "bad" };
}

export function Workspace({
  csrfToken,
  onUnauthorized,
}: {
  csrfToken: string;
  onUnauthorized: () => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    window.localStorage.getItem(SELECTED_KEY),
  );
  const [summary, setSummary] = useState<Map<string, Counts>>(new Map());
  const [summaryNow, setSummaryNow] = useState(0);
  const [engineReachable, setEngineReachable] = useState(true);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [modal, setModal] = useState<Modal>(null);

  const fail = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setLoadError(friendlyError(caught).message);
    },
    [onUnauthorized],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload after adding or removing.
  useEffect(() => {
    const controller = new AbortController();
    void apiGet(
      "/api/projects",
      (value) => ProjectListResponseSchema.parse(value),
      controller.signal,
    )
      .then(({ projects: loaded }) => {
        if (controller.signal.aborted) return;
        setLoadError(null);
        setProjects(loaded);
        setSelectedId((current) =>
          current !== null && loaded.some((project) => project.id === current)
            ? current
            : (loaded[0]?.id ?? null),
        );
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) fail(caught);
      });
    return () => controller.abort();
  }, [fail, reload]);

  useEffect(() => {
    void apiGet("/api/system", (value) => SystemInfoResponseSchema.parse(value))
      .then(setSystem)
      .catch(() => setSystem(null));
  }, []);

  // The sidebar's running/failed counts double as a heartbeat for the engine.
  // biome-ignore lint/correctness/useExhaustiveDependencies: summaryNow forces a refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const { projects: counts } = await apiGet("/api/runtime/summary", (value) =>
          RuntimeSummaryResponseSchema.parse(value),
        );
        if (cancelled) return;
        setEngineReachable(true);
        setSummary(new Map(counts.map((entry) => [entry.projectId, entry])));
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          onUnauthorized();
          return;
        }
        setEngineReachable(!(caught instanceof TypeError));
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), SUMMARY_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [summaryNow, onUnauthorized]);

  useEffect(() => {
    if (selectedId === null) window.localStorage.removeItem(SELECTED_KEY);
    else window.localStorage.setItem(SELECTED_KEY, selectedId);
  }, [selectedId]);

  async function addProject() {
    if (!isDesktop()) {
      setModal({ kind: "add", path: null });
      return;
    }
    try {
      const picked = await pickFolder();
      if (picked !== null) setModal({ kind: "add", path: picked });
    } catch {
      setModal({ kind: "add", path: null });
    }
  }

  const dialogs = (
    <>
      {modal?.kind === "add" ? (
        <AddProjectDialog
          csrfToken={csrfToken}
          initialPath={modal.path}
          onClose={() => setModal(null)}
          onAdded={(project) => {
            setModal(null);
            setSelectedId(project.id);
            setReload((value) => value + 1);
            setSummaryNow((value) => value + 1);
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {modal?.kind === "help" ? <HowItWorksDialog onClose={() => setModal(null)} /> : null}
    </>
  );

  if (projects === null) {
    return (
      <main className="splash" aria-live="polite">
        <Logo big />
        {loadError === null ? (
          <p>Loading your projects…</p>
        ) : (
          <>
            <p role="alert">{loadError}</p>
            <button className="btn secondary" type="button" onClick={() => setReload((v) => v + 1)}>
              Try again
            </button>
          </>
        )}
      </main>
    );
  }

  if (projects.length === 0) {
    return (
      <>
        <Welcome onAddProject={() => void addProject()} />
        {dialogs}
      </>
    );
  }

  const selected = projects.find((project) => project.id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Projects">
        <div className="brand">
          <Logo />
          DevDock
        </div>
        <div className="side-head">
          <h2 className="side-label">Projects</h2>
          <button
            className="btn icon-only ghost tiny"
            type="button"
            aria-label="Add project"
            title="Add project"
            onClick={() => void addProject()}
          >
            <Icon name="plus" />
          </button>
        </div>
        <nav className="projects">
          {projects.map((project) => {
            const status = projectStatus(summary.get(project.id));
            return (
              <button
                key={project.id}
                type="button"
                className={project.id === selectedId ? "project active" : "project"}
                aria-current={project.id === selectedId ? "page" : undefined}
                onClick={() => setSelectedId(project.id)}
              >
                <span className={`dot ${status.dot}`} aria-hidden="true" />
                <span className="pname">
                  {project.displayName}
                  <small className={status.tone}>{status.text}</small>
                </span>
              </button>
            );
          })}
        </nav>
        <div className="side-footer">
          <button className="help-link" type="button" onClick={() => setModal({ kind: "help" })}>
            <Icon name="help" />
            How DevDock works
          </button>
          <span
            className="engine"
            title={
              system?.projectNode.source === "daemon"
                ? "Scripts run with the Node.js built into DevDock, because none was found on this computer."
                : "Scripts run with the Node.js installed on this computer."
            }
          >
            <span className={engineReachable ? "dot ready" : "dot failed"} aria-hidden="true" />
            {engineReachable
              ? `DevDock is running · ${nodeLabel(system)}`
              : "Can't reach DevDock's engine"}
          </span>
        </div>
      </aside>
      {selected === null ? (
        <main className="content">
          <p className="loading">Choose a project on the left.</p>
        </main>
      ) : (
        <ProjectView
          key={selected.id}
          project={selected}
          csrfToken={csrfToken}
          system={system}
          onUnauthorized={onUnauthorized}
          onRemoved={() => {
            setSelectedId(null);
            setReload((value) => value + 1);
          }}
          onActivity={() => setSummaryNow((value) => value + 1)}
        />
      )}
      {dialogs}
    </div>
  );
}
