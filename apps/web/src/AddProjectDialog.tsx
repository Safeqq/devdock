import { FolderInspectionResponseSchema, ProjectResponseSchema } from "@devdock/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ApiError, apiPost, type FolderInspection, friendlyError, type Project } from "./api";
import { Dialog } from "./Dialog";
import { isDesktop, pickFolder } from "./desktop";
import { Icon } from "./icons";
import { isAutomaticScript, scriptHint } from "./scripts";

// Shows what a folder contains before it is added, so nothing is registered or run by surprise.
export function AddProjectDialog({
  csrfToken,
  initialPath,
  onClose,
  onAdded,
  onUnauthorized,
}: {
  csrfToken: string;
  initialPath: string | null;
  onClose: () => void;
  onAdded: (project: Project) => void;
  onUnauthorized: () => void;
}) {
  const desktop = isDesktop();
  const [path, setPath] = useState(initialPath ?? "");
  const [inspection, setInspection] = useState<FolderInspection | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"inspect" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  async function inspect(target: string) {
    setBusy("inspect");
    setError(null);
    try {
      const result = await apiPost(
        "/api/folders/inspect",
        { path: target },
        (value) => FolderInspectionResponseSchema.parse(value),
        csrfToken,
      );
      setInspection(result);
      setName(result.folder.suggestedName);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
    } finally {
      setBusy(null);
    }
  }

  // A folder picked in the native dialog is inspected straight away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Runs once for the picked folder.
  useEffect(() => {
    if (started.current || initialPath === null) return;
    started.current = true;
    void inspect(initialPath);
  }, []);

  async function browse() {
    const picked = await pickFolder().catch(() => null);
    if (picked === null) return;
    setPath(picked);
    await inspect(picked);
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inspection === null) return;
    setBusy("add");
    setError(null);
    const displayName = name.trim();
    try {
      const { project } = await apiPost(
        "/api/projects",
        {
          path: inspection.folder.displayPath,
          ...(displayName === "" ? {} : { displayName }),
        },
        (value) => ProjectResponseSchema.parse(value),
        csrfToken,
      );
      onAdded(project);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
      setBusy(null);
    }
  }

  const scripts = inspection?.discovery.scripts ?? [];
  const allNames = new Set(scripts.map((script) => script.name));
  const main = scripts.filter((script) => !isAutomaticScript(script.name, allNames));
  const automatic = scripts.length - main.length;

  return (
    <Dialog onClose={onClose} labelledBy="add-title">
      <div className="modal-icon">
        <Icon name="folder" />
      </div>
      {inspection === null ? (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void inspect(path.trim());
          }}
        >
          <h2 id="add-title">Add a project</h2>
          <div className="field">
            <label htmlFor="add-folder">Project folder</label>
            <span className="field-row">
              <input
                id="add-folder"
                aria-describedby="add-folder-help"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="C:\Code\my-app"
                maxLength={4096}
                spellCheck={false}
              />
              {desktop ? (
                <button className="btn secondary" type="button" onClick={() => void browse()}>
                  Browse…
                </button>
              ) : null}
            </span>
            <small id="add-folder-help">
              The folder that contains package.json. Nothing runs until you press Start.
            </small>
          </div>
          {busy === "inspect" ? (
            <p className="hint" aria-live="polite">
              Looking inside…
            </p>
          ) : null}
          {error === null ? null : (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="submit"
              disabled={busy !== null || path.trim() === ""}
            >
              Look inside
            </button>
          </div>
        </form>
      ) : (
        <form className="dialog-form" onSubmit={(event) => void add(event)}>
          <h2 id="add-title">Add this project?</h2>
          <p className="path big">{inspection.folder.displayPath}</p>
          <div className="found-head">
            <span>
              Found{" "}
              <strong>
                {scripts.length} {scripts.length === 1 ? "script" : "scripts"}
              </strong>{" "}
              in <code>package.json</code>
            </span>
            <span className="safe">
              <Icon name="check" />
              Nothing runs until you press Start
            </span>
          </div>
          {main.length === 0 ? (
            <p className="hint">
              {scripts.length === 0
                ? "package.json has no scripts yet. You can still add the project and come back once it has some."
                : "Only scripts that npm runs by itself were found."}
            </p>
          ) : (
            <ul className="found" aria-label="Scripts found">
              {main.map((script) => (
                <li key={script.name}>
                  <code>{script.name}</code>
                  <span className="found-desc">
                    {scriptHint(script.name, script.command).description ?? script.command}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {automatic > 0 ? (
            <p className="hint">
              Plus {automatic} {automatic === 1 ? "script" : "scripts"} that npm runs by itself,
              such as postinstall. They are listed under “More scripts”.
            </p>
          ) : null}
          {inspection.discovery.unsupportedScriptCount > 0 ? (
            <p className="hint">
              {inspection.discovery.unsupportedScriptCount} script name(s) can't be run safely and
              are skipped.
            </p>
          ) : null}
          <label className="field">
            Name shown in DevDock
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={128}
              required
            />
          </label>
          {error === null ? null : (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="btn ghost push-left"
              type="button"
              onClick={() => {
                setInspection(null);
                setError(null);
              }}
            >
              Choose another folder
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn primary"
              type="submit"
              disabled={busy !== null || name.trim() === ""}
            >
              <Icon name="plus" />
              {busy === "add" ? "Adding…" : "Add project"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
