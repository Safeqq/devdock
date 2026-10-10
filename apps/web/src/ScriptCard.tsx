import type { MouseEvent } from "react";
import type { Service } from "./api";
import { Icon } from "./icons";
import type { ScriptHint } from "./scripts";
import { type CardState, shortAddress, startLabel, type Tone } from "./status";

// One npm script as the user sees it. A service record exists once it has been run or configured.
export interface ScriptEntry {
  readonly key: string;
  readonly scriptName: string;
  readonly title: string;
  readonly command: string | null;
  readonly service: Service | null;
  // Set for scripts that run in a subfolder of the project.
  readonly location: string | null;
  readonly hint: ScriptHint;
}

export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className={`pill ${tone}`}>
      {tone === "ready" ? <span className="pulse" aria-hidden="true" /> : null}
      {tone === "starting" ? <span className="spinner" aria-hidden="true" /> : null}
      {tone === "done" ? <Icon name="check" /> : null}
      {tone === "failed" ? <Icon name="x" /> : null}
      {tone === "unknown" ? <Icon name="alert" /> : null}
      {label}
    </span>
  );
}

function kindText(hint: ScriptHint): string | null {
  if (hint.kind === "keeps-running") return "keeps running";
  if (hint.kind === "runs-once") return "runs once";
  return null;
}

export function ScriptCard({
  entry,
  state,
  recommended,
  selected,
  busy,
  onStart,
  onStop,
  onOpen,
  onSettings,
  onCheck,
}: {
  entry: ScriptEntry;
  state: CardState;
  recommended: boolean;
  selected: boolean;
  busy: "start" | "stop" | null;
  onStart: () => void;
  onStop: () => void;
  onOpen: (url: string, event: MouseEvent<HTMLAnchorElement>) => void;
  onSettings: () => void;
  onCheck: () => void;
}) {
  const description = [entry.hint.description, kindText(entry.hint)].filter(Boolean).join(" · ");
  const classes = ["card"];
  if (state.active) classes.push("live");
  if (state.tone === "failed" || state.tone === "unknown") classes.push("problem");
  if (recommended && !state.hasRun) classes.push("recommended");
  if (selected) classes.push("selected");
  const label = startLabel(entry.hint.kind, state);

  return (
    <article className={classes.join(" ")} aria-label={`${entry.title} script`}>
      <div className="card-head">
        <h3>{entry.title}</h3>
        {state.active && state.url !== null ? (
          <span className="url">{shortAddress(state.url)}</span>
        ) : recommended && !state.hasRun ? (
          <span className="tag">Recommended</span>
        ) : null}
      </div>
      {description === "" ? null : <p className="desc">{description}</p>}
      <p className="cmd" title={entry.command ?? undefined}>
        <Icon name="terminal" />
        <span className="cmd-text">{entry.command ?? `npm run ${entry.scriptName}`}</span>
      </p>
      {entry.location === null ? null : <p className="meta">Runs in {entry.location}</p>}
      {state.why === null ? null : (
        <p className="why">
          <Icon name="alert" />
          <span>{state.why}</span>
        </p>
      )}
      {state.meta === null ? null : <p className="meta">{state.meta}</p>}
      <div className="card-foot">
        <StatusPill tone={state.tone} label={state.label} />
        <div className="actions">
          {state.active ? (
            <>
              {state.url === null ? null : (
                <a
                  className="btn primary"
                  href={state.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => onOpen(state.url as string, event)}
                  aria-label={`Open ${entry.title} in your browser`}
                >
                  <Icon name="open" />
                  Open
                </a>
              )}
              <button
                className="btn danger-soft"
                type="button"
                onClick={onStop}
                disabled={busy !== null || state.label === "Stopping…"}
                aria-label={`Stop ${entry.title}`}
              >
                <Icon name="stop" />
                {busy === "stop" ? "Stopping…" : "Stop"}
              </button>
            </>
          ) : state.tone === "unknown" ? (
            <button
              className="btn secondary"
              type="button"
              onClick={onCheck}
              aria-label={`Check whether ${entry.title} is still running`}
            >
              <Icon name="help" />
              Check
            </button>
          ) : (
            <button
              className={recommended && !state.hasRun ? "btn primary" : "btn secondary"}
              type="button"
              onClick={onStart}
              disabled={busy !== null || !state.canStart}
              aria-label={`${label} ${entry.title}`}
            >
              <Icon name={label === "Run again" ? "redo" : "play"} />
              {busy === "start" ? "Starting…" : label}
            </button>
          )}
          <button
            className="btn icon-only ghost"
            type="button"
            onClick={onSettings}
            aria-label={`Settings for ${entry.title}`}
            title="Settings"
          >
            <Icon name="gear" />
          </button>
        </div>
      </div>
    </article>
  );
}
