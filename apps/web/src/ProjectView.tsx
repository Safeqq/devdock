import {
  DiscoveryResponseSchema,
  ProfileRuntimeStatusResponseSchema,
  ProfileStartResponseSchema,
  ProfileStopResponseSchema,
  ProjectDetailResponseSchema,
  ProjectResponseSchema,
  ServiceResponseSchema,
  ServiceRuntimeStatusResponseSchema,
  ServiceStartResponseSchema,
  ServiceStopResponseSchema,
} from "@devdock/contracts";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  apiAction,
  apiGet,
  apiPost,
  type Discovery,
  friendlyError,
  type ProfileOperationSnapshot,
  type Project,
  type ProjectDetail,
  reasonMessage,
  type Service,
  type ServiceStatus,
  type SystemInfo,
} from "./api";
import { Dialog } from "./Dialog";
import { isDesktop, openFolder, openInBrowser } from "./desktop";
import { GroupCard } from "./GroupCard";
import { Icon } from "./icons";
import { NewGroupDialog } from "./NewGroupDialog";
import { OutputPanel, type OutputTab } from "./OutputPanel";
import { ScriptCard, type ScriptEntry } from "./ScriptCard";
import { ScriptSettings } from "./ScriptSettings";
import { isAutomaticScript, recommendedScript, scriptHint } from "./scripts";
import { type CardState, cardState, duration } from "./status";

const ACTIVE_POLL_MS = 1_000;
const IDLE_POLL_MS = 3_000;

type Notice = { tone: "error" | "info"; text: string; code: string | null };

function quickStartKey(projectId: string) {
  return `devdock.quickStartDismissed.${projectId}`;
}

function subfolder(project: Project, service: Service): string | null {
  if (service.cwd.canonicalPath === project.path.canonicalPath) return null;
  const root = project.path.displayPath;
  const inside = service.cwd.displayPath.startsWith(root)
    ? service.cwd.displayPath.slice(root.length).replace(/^[\\/]+/u, "")
    : service.cwd.displayPath;
  return inside === "" ? null : inside;
}

// Scripts from package.json, each matched with the service that remembers its settings and runs.
// Services created for subfolders or extra copies of a script get their own cards.
function scriptEntries(detail: ProjectDetail, discovery: Discovery | null) {
  const root = detail.project.path.canonicalPath;
  const scripts = discovery?.scripts ?? [];
  const names = new Set(scripts.map((script) => script.name));
  const used = new Set<string>();
  const main: ScriptEntry[] = [];
  const more: ScriptEntry[] = [];
  for (const script of scripts) {
    const service =
      detail.services.find(
        (candidate) =>
          candidate.scriptName === script.name &&
          candidate.cwd.canonicalPath === root &&
          !used.has(candidate.id),
      ) ?? null;
    if (service !== null) used.add(service.id);
    const entry: ScriptEntry = {
      key: `script:${script.name}`,
      scriptName: script.name,
      title: script.name,
      command: script.command,
      service,
      location: null,
      hint: scriptHint(script.name, script.command),
    };
    if (service === null && isAutomaticScript(script.name, names)) more.push(entry);
    else main.push(entry);
  }
  for (const service of detail.services) {
    if (used.has(service.id)) continue;
    main.push({
      key: service.id,
      scriptName: service.scriptName,
      title: service.displayName,
      command: null,
      service,
      location: subfolder(detail.project, service),
      hint: scriptHint(service.scriptName, null),
    });
  }
  return { main, more };
}

function ending(state: CardState, status: ServiceStatus | undefined): string | null {
  const snapshot = status?.snapshot ?? null;
  if (snapshot === null || state.active) return null;
  if (snapshot.processState === "exited") {
    return snapshot.endedAt === undefined
      ? "Finished."
      : `Finished in ${duration(snapshot.startedAt, snapshot.endedAt)}.`;
  }
  if (snapshot.processState === "failed") {
    return snapshot.failureReason === "PROCESS_EXITED_WITH_FAILURE" ||
      snapshot.failureReason === undefined
      ? `Stopped with an error${snapshot.exitCode == null ? "" : ` (exit code ${snapshot.exitCode})`}.`
      : reasonMessage(snapshot.failureReason);
  }
  if (snapshot.processState === "stopped") return "Stopped.";
  return null;
}

function readStatus(value: unknown): ServiceStatus {
  const parsed = ServiceRuntimeStatusResponseSchema.parse(value);
  return { snapshot: parsed.snapshot, ownership: parsed.ownership, appUrl: parsed.appUrl ?? null };
}

export function ProjectView({
  project,
  csrfToken,
  system,
  onUnauthorized,
  onRemoved,
  onActivity,
}: {
  project: Project;
  csrfToken: string;
  system: SystemInfo | null;
  onUnauthorized: () => void;
  onRemoved: () => void;
  onActivity: () => void;
}) {
  const desktop = isDesktop();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [groups, setGroups] = useState<Record<string, ProfileOperationSnapshot | null>>({});
  const [runtimeAvailable, setRuntimeAvailable] = useState(true);
  // Scripts can be run only where the daemon has a process adapter for this platform.
  const canRun = runtimeAvailable && system?.serviceControl !== false;
  const [pollNow, setPollNow] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Record<string, "start" | "stop">>({});
  const [groupBusy, setGroupBusy] = useState<Record<string, boolean>>({});
  const [stoppingAll, setStoppingAll] = useState(false);
  const [outputId, setOutputId] = useState<string | null>(null);
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [quickStartDismissed, setQuickStartDismissed] = useState(
    () => window.localStorage.getItem(quickStartKey(project.id)) === "1",
  );
  const menu = useRef<HTMLDivElement>(null);

  const fail = useCallback(
    (caught: unknown, prefix?: string) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      const { message, code } = friendlyError(caught);
      setNotice({
        tone: "error",
        text: prefix === undefined ? message : `${prefix} ${message}`,
        code,
      });
    },
    [onUnauthorized],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload on demand.
  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    void apiGet(
      `/api/projects/${project.id}`,
      (value) => ProjectDetailResponseSchema.parse(value),
      controller.signal,
    )
      .then((loaded) => {
        if (!controller.signal.aborted) setDetail(loaded);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else setLoadError(friendlyError(caught).message);
      });
    void apiGet(
      `/api/projects/${project.id}/scripts`,
      (value) => DiscoveryResponseSchema.parse(value),
      controller.signal,
    )
      .then(({ discovery: loaded }) => {
        if (controller.signal.aborted) return;
        setDiscovery(loaded);
        setDiscoveryError(null);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else setDiscoveryError(friendlyError(caught).message);
      });
    return () => controller.abort();
  }, [project.id, reload, onUnauthorized]);

  // Status polling: quick while something is starting or running, relaxed otherwise.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pollNow forces an immediate refresh.
  useEffect(() => {
    if (detail === null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      let active = false;
      if (runtimeAvailable) {
        const results = await Promise.all(
          detail.services.map(async (service) => {
            try {
              return [
                service.id,
                readStatus(await apiGet(`/api/services/${service.id}/status`, (v) => v)),
              ] as const;
            } catch (caught) {
              return [service.id, caught] as const;
            }
          }),
        );
        const profileResults = await Promise.all(
          detail.profiles.map(async (profile) => {
            try {
              const { snapshot } = await apiGet(`/api/profiles/${profile.id}/status`, (value) =>
                ProfileRuntimeStatusResponseSchema.parse(value),
              );
              return [profile.id, snapshot] as const;
            } catch (caught) {
              return [profile.id, caught] as const;
            }
          }),
        );
        if (cancelled) return;
        const failures = [...results, ...profileResults]
          .map(([, value]) => value)
          .filter((value) => value instanceof Error);
        if (failures.some((value) => value instanceof ApiError && value.status === 401)) {
          onUnauthorized();
          return;
        }
        if (failures.some((value) => value instanceof ApiError && value.status === 501)) {
          setRuntimeAvailable(false);
        }
        const nextStatuses: Record<string, ServiceStatus> = {};
        for (const [id, value] of results) {
          if (!(value instanceof Error)) nextStatuses[id] = value as ServiceStatus;
        }
        const nextGroups: Record<string, ProfileOperationSnapshot | null> = {};
        for (const [id, value] of profileResults) {
          if (!(value instanceof Error)) nextGroups[id] = value as ProfileOperationSnapshot | null;
        }
        setStatuses((current) => ({ ...current, ...nextStatuses }));
        setGroups((current) => ({ ...current, ...nextGroups }));
        active =
          Object.values(nextStatuses).some(
            (status) =>
              status.snapshot !== null &&
              ["starting", "running", "stopping"].includes(status.snapshot.processState),
          ) ||
          Object.values(nextGroups).some(
            (snapshot) =>
              snapshot !== null && ["starting", "ready", "stopping"].includes(snapshot.state),
          );
      }
      setNow(Date.now());
      if (!cancelled)
        timer = window.setTimeout(() => void tick(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [detail, pollNow, runtimeAvailable, onUnauthorized]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "pointerdown" && menu.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const { main, more } = useMemo(
    () => (detail === null ? { main: [], more: [] } : scriptEntries(detail, discovery)),
    [detail, discovery],
  );
  const allEntries = useMemo(() => [...main, ...more], [main, more]);
  const recommended = useMemo(
    () =>
      recommendedScript(
        main.filter((entry) => entry.location === null).map((entry) => entry.scriptName),
      ),
    [main],
  );
  const states = new Map(
    allEntries.map((entry) => {
      const state = cardState(
        entry.service,
        entry.service === null ? undefined : statuses[entry.service.id],
        entry.hint.kind,
        now,
      );
      return [entry.key, canRun ? state : { ...state, canStart: false }] as const;
    }),
  );
  const serviceNames = new Map(
    allEntries.flatMap((entry) =>
      entry.service === null ? [] : [[entry.service.id, entry.title] as const],
    ),
  );

  function replaceService(service: Service) {
    setDetail((current) =>
      current === null
        ? current
        : {
            ...current,
            services: current.services.some((entry) => entry.id === service.id)
              ? current.services.map((entry) => (entry.id === service.id ? service : entry))
              : [...current.services, service],
          },
    );
  }

  async function ensureService(entry: ScriptEntry): Promise<Service> {
    if (entry.service !== null) return entry.service;
    const { service } = await apiPost(
      `/api/projects/${project.id}/services`,
      { scriptName: entry.scriptName },
      (value) => ServiceResponseSchema.parse(value),
      csrfToken,
    );
    replaceService(service);
    return service;
  }

  async function start(entry: ScriptEntry) {
    setBusy((current) => ({ ...current, [entry.key]: "start" }));
    setNotice(null);
    try {
      const service = await ensureService(entry);
      const { outcome } = await apiAction(
        `/api/services/${service.id}/start`,
        (value) => ServiceStartResponseSchema.parse(value),
        csrfToken,
      );
      setStatuses((current) => ({
        ...current,
        [service.id]: {
          snapshot: outcome.snapshot,
          ownership:
            outcome.kind === "rejected" ? (current[service.id]?.ownership ?? null) : "owned",
          appUrl: null,
        },
      }));
      if (outcome.kind !== "rejected") setOutputId(service.id);
      if (outcome.kind === "failed" || outcome.kind === "rejected") {
        setNotice({
          tone: "error",
          text: `${entry.title} couldn't start. ${reasonMessage(outcome.reason)}`,
          code: outcome.reason,
        });
      }
      onActivity();
    } catch (caught) {
      fail(caught, `${entry.title} couldn't start.`);
    } finally {
      setBusy(({ [entry.key]: _done, ...rest }) => rest);
      setPollNow((value) => value + 1);
    }
  }

  async function stopService(service: Service, title: string) {
    const { outcome } = await apiAction(
      `/api/services/${service.id}/stop`,
      (value) => ServiceStopResponseSchema.parse(value),
      csrfToken,
    );
    if (outcome.snapshot !== null) {
      const snapshot = outcome.snapshot;
      setStatuses((current) => ({
        ...current,
        [service.id]: { snapshot, ownership: null, appUrl: null },
      }));
    }
    if (outcome.kind === "incomplete") {
      setNotice({
        tone: "error",
        text: `DevDock couldn't confirm that ${title} stopped. ${reasonMessage(outcome.reason)}`,
        code: outcome.reason,
      });
    }
  }

  async function stop(entry: ScriptEntry) {
    if (entry.service === null) return;
    setBusy((current) => ({ ...current, [entry.key]: "stop" }));
    setNotice(null);
    try {
      await stopService(entry.service, entry.title);
      onActivity();
    } catch (caught) {
      fail(caught, `${entry.title} couldn't be stopped.`);
    } finally {
      setBusy(({ [entry.key]: _done, ...rest }) => rest);
      setPollNow((value) => value + 1);
    }
  }

  function open(url: string, event: MouseEvent<HTMLAnchorElement>) {
    if (!desktop) return;
    event.preventDefault();
    void openInBrowser(url).catch(() =>
      setNotice({
        tone: "error",
        text: `Your browser couldn't be opened. The address is ${url}`,
        code: null,
      }),
    );
  }

  async function groupAction(profileId: string, action: "start" | "stop") {
    setGroupBusy((current) => ({ ...current, [profileId]: true }));
    setNotice(null);
    try {
      const { outcome } =
        action === "start"
          ? await apiPost(
              `/api/profiles/${profileId}/start`,
              {},
              (value) => ProfileStartResponseSchema.parse(value),
              csrfToken,
            )
          : await apiPost(
              `/api/profiles/${profileId}/stop`,
              {},
              (value) => ProfileStopResponseSchema.parse(value),
              csrfToken,
            );
      setGroups((current) => ({ ...current, [profileId]: outcome.snapshot }));
      onActivity();
    } catch (caught) {
      fail(caught, action === "start" ? "The group couldn't start." : "The group couldn't stop.");
    } finally {
      setGroupBusy(({ [profileId]: _done, ...rest }) => rest);
      setPollNow((value) => value + 1);
    }
  }

  const activeEntries = allEntries.filter((entry) => states.get(entry.key)?.active === true);
  const activeGroups = (detail?.profiles ?? []).filter((profile) => {
    const state = groups[profile.id]?.state;
    return state === "starting" || state === "ready";
  });

  async function stopAll() {
    setStoppingAll(true);
    setNotice(null);
    try {
      for (const profile of activeGroups) {
        await apiPost(
          `/api/profiles/${profile.id}/stop`,
          {},
          (value) => ProfileStopResponseSchema.parse(value),
          csrfToken,
        );
      }
      for (const entry of activeEntries) {
        if (entry.service !== null) await stopService(entry.service, entry.title);
      }
      onActivity();
    } catch (caught) {
      fail(caught, "Not everything could be stopped.");
    } finally {
      setStoppingAll(false);
      setPollNow((value) => value + 1);
    }
  }

  async function remove() {
    try {
      await apiPost(
        `/api/projects/${project.id}/archive`,
        {},
        (value) => ProjectResponseSchema.parse(value),
        csrfToken,
      );
      setConfirmRemove(false);
      onRemoved();
    } catch (caught) {
      setConfirmRemove(false);
      fail(caught, "The project couldn't be removed.");
    }
  }

  function dismissQuickStart() {
    window.localStorage.setItem(quickStartKey(project.id), "1");
    setQuickStartDismissed(true);
  }

  if (detail === null) {
    return (
      <main className="content">
        {loadError === null ? (
          <p className="loading" aria-live="polite">
            Loading {project.displayName}…
          </p>
        ) : (
          <p className="notice error" role="alert">
            <Icon name="alert" />
            <span>{loadError}</span>
          </p>
        )}
      </main>
    );
  }

  const outputTabs: OutputTab[] = allEntries.flatMap((entry) => {
    if (entry.service === null) return [];
    const status = statuses[entry.service.id];
    const snapshot = status?.snapshot ?? null;
    const state = states.get(entry.key);
    if (snapshot === null || state === undefined) return [];
    return [
      {
        serviceId: entry.service.id,
        title: entry.title,
        runId: snapshot.runId,
        tone: state.tone,
        ending: ending(state, status),
      },
    ];
  });
  const selectedOutput =
    outputTabs.find((tab) => tab.serviceId === outputId)?.serviceId ??
    outputTabs.find((tab) => tab.ending === null)?.serviceId ??
    outputTabs[0]?.serviceId ??
    null;
  const nothingRunYet = allEntries.every(
    (entry) => entry.service === null || (statuses[entry.service.id]?.snapshot ?? null) === null,
  );
  const settingsEntry = allEntries.find((entry) => entry.key === settingsKey) ?? null;
  const stopCount = activeEntries.length;

  const card = (entry: ScriptEntry) => (
    <ScriptCard
      key={entry.key}
      entry={entry}
      state={states.get(entry.key) as CardState}
      recommended={entry.scriptName === recommended && entry.location === null}
      selected={entry.service !== null && entry.service.id === selectedOutput}
      busy={busy[entry.key] ?? null}
      onStart={() => void start(entry)}
      onStop={() => void stop(entry)}
      onOpen={open}
      onSettings={() => setSettingsKey(entry.key)}
    />
  );

  return (
    <main className="content">
      <div className="content-scroll">
        <header className="project-header">
          <div>
            <p className="eyebrow">Project</p>
            <h1>{detail.project.displayName}</h1>
            <p className="path">
              <Icon name="folder" />
              <span>{detail.project.path.displayPath}</span>
              {desktop ? (
                <>
                  {" · "}
                  <button
                    className="link-button"
                    type="button"
                    onClick={() =>
                      void openFolder(detail.project.path.displayPath).catch(() =>
                        setNotice({
                          tone: "error",
                          text: "The folder couldn't be opened.",
                          code: null,
                        }),
                      )
                    }
                  >
                    Open folder
                  </button>
                </>
              ) : null}
            </p>
          </div>
          <div className="header-actions">
            {stopCount > 0 ? (
              <button
                className="btn danger-soft"
                type="button"
                onClick={() => void stopAll()}
                disabled={stoppingAll}
              >
                <Icon name="stop" />
                {stoppingAll ? "Stopping…" : `Stop all (${stopCount})`}
              </button>
            ) : null}
            <div className="menu-anchor" ref={menu}>
              <button
                className="btn icon-only ghost"
                type="button"
                aria-label="Project options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <Icon name="more" />
              </button>
              {menuOpen ? (
                <div className="menu" role="menu">
                  <a
                    role="menuitem"
                    href={`/api/projects/${detail.project.id}/export`}
                    download="devdock-configuration.json"
                    onClick={() => setMenuOpen(false)}
                  >
                    <Icon name="download" />
                    Export settings
                  </a>
                  <button
                    role="menuitem"
                    type="button"
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirmRemove(true);
                    }}
                  >
                    <Icon name="trash" />
                    Remove from DevDock
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {notice === null ? null : (
          <div
            className={`notice ${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            <Icon name={notice.tone === "error" ? "alert" : "check"} />
            <span>
              {notice.text}
              {notice.code === null ? null : <small className="code"> ({notice.code})</small>}
            </span>
            <button
              className="btn icon-only ghost tiny"
              type="button"
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
            >
              <Icon name="x" />
            </button>
          </div>
        )}
        {discoveryError === null ? null : (
          <div className="notice error" role="alert">
            <Icon name="alert" />
            <span>DevDock couldn't read this project's scripts. {discoveryError}</span>
            <button
              className="btn ghost tiny"
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        )}
        {canRun ? null : (
          <div className="notice info" role="status">
            <Icon name="help" />
            <span>
              Running scripts isn't available on this system. You can still look around and change
              settings.
            </span>
          </div>
        )}
        {recommended !== null && nothingRunYet && !quickStartDismissed && canRun ? (
          <div className="banner">
            <Icon name="spark" />
            <p>
              <strong>Quick start:</strong> press <strong>Start</strong> on{" "}
              <code>{recommended}</code> — it's usually the script that runs your app while you
              work. When its status turns{" "}
              <span className="nowrap">
                <span className="pill ready small">Ready</span>,
              </span>{" "}
              click <strong>Open</strong> to see it in your browser.
            </p>
            <button
              className="btn icon-only ghost tiny"
              type="button"
              aria-label="Dismiss quick start"
              onClick={dismissQuickStart}
            >
              <Icon name="x" />
            </button>
          </div>
        ) : null}

        <div className="section-head">
          <div>
            <p className="section-title">From package.json</p>
            <h2>Scripts</h2>
          </div>
          <p className="section-hint">
            Start runs a script · the gear holds optional settings · output appears below
          </p>
        </div>
        {main.length === 0 && discoveryError === null && discovery !== null ? (
          <div className="empty-card">
            <p>
              {more.length === 0
                ? "package.json has no scripts yet. Add one — for example "
                : "This project only has scripts that npm runs by itself. Add your own — for example "}
              <code>"dev": "vite"</code> — and press <strong>Check again</strong>.
            </p>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setReload((value) => value + 1)}
            >
              <Icon name="redo" />
              Check again
            </button>
          </div>
        ) : (
          <div className="cards">{main.map(card)}</div>
        )}
        {more.length === 0 ? null : (
          <details className="more-scripts">
            <summary>
              More scripts ({more.length}){" "}
              <span className="summary-note">— npm usually runs these by itself</span>
            </summary>
            <div className="cards">{more.map(card)}</div>
          </details>
        )}

        {allEntries.length >= 2 || detail.profiles.length > 0 ? (
          <>
            <div className="section-head">
              <div>
                <p className="section-title">One click, several scripts</p>
                <h2>Groups</h2>
              </div>
              <div className="section-actions">
                <p className="section-hint">For example your API first, then the website</p>
                {allEntries.length >= 2 ? (
                  <button className="btn tiny" type="button" onClick={() => setCreatingGroup(true)}>
                    <Icon name="plus" />
                    New group
                  </button>
                ) : null}
              </div>
            </div>
            {detail.profiles.length === 0 ? (
              <p className="hint">
                No groups yet. A group starts several scripts with one click, in the order you
                choose — press <strong>New group</strong> to make one.
              </p>
            ) : (
              <div className="cards">
                {detail.profiles.map((profile) => (
                  <GroupCard
                    key={profile.id}
                    profile={profile}
                    snapshot={groups[profile.id] ?? null}
                    names={serviceNames}
                    busy={groupBusy[profile.id] === true || !canRun}
                    onStart={() => void groupAction(profile.id, "start")}
                    onStop={() => void groupAction(profile.id, "stop")}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </div>

      <OutputPanel tabs={outputTabs} selectedId={selectedOutput} onSelect={setOutputId} />

      {settingsEntry === null ? null : (
        <ScriptSettings
          entry={settingsEntry}
          projectId={project.id}
          projectPath={detail.project.path.displayPath}
          system={system}
          running={states.get(settingsEntry.key)?.active === true}
          csrfToken={csrfToken}
          onClose={() => setSettingsKey(null)}
          onSaved={(service) => {
            replaceService(service);
            setSettingsKey(null);
            setNotice({
              tone: "info",
              text: `Saved settings for ${settingsEntry.title}.`,
              code: null,
            });
          }}
          onUnauthorized={onUnauthorized}
        />
      )}
      {creatingGroup ? (
        <NewGroupDialog
          entries={main}
          projectId={project.id}
          csrfToken={csrfToken}
          ensureService={ensureService}
          onClose={() => setCreatingGroup(false)}
          onCreated={(profile) => {
            setCreatingGroup(false);
            setDetail((current) =>
              current === null ? current : { ...current, profiles: [...current.profiles, profile] },
            );
            setPollNow((value) => value + 1);
          }}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {confirmRemove ? (
        <Dialog onClose={() => setConfirmRemove(false)} labelledBy="remove-title">
          <div className="dialog-form">
            <h2 id="remove-title">Remove {detail.project.displayName} from DevDock?</h2>
            <p className="hint">
              Your files stay exactly where they are. You can add the folder again any time.
              {stopCount > 0 ? " Stop its running scripts first." : ""}
            </p>
            <div className="modal-actions">
              <button className="btn ghost" type="button" onClick={() => setConfirmRemove(false)}>
                Cancel
              </button>
              <button className="btn danger-soft" type="button" onClick={() => void remove()}>
                <Icon name="trash" />
                Remove
              </button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </main>
  );
}
