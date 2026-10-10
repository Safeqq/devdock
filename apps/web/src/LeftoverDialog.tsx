import { RunSnapshotResponseSchema, ServiceLeftoverResponseSchema } from "@devdock/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  apiGet,
  apiPost,
  friendlyError,
  type RunSnapshot,
  type Service,
  type ServiceLeftover,
} from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";

// Helps the user settle a script whose status DevDock lost, usually because DevDock itself was
// closed abruptly. DevDock never stops or adopts a program it cannot prove it started, so it only
// shows what it can see and lets the user confirm once the program is gone.
export function LeftoverDialog({
  title,
  service,
  csrfToken,
  onClose,
  onMarkedStopped,
  onStopAgain,
  onUnauthorized,
}: {
  title: string;
  service: Service;
  csrfToken: string;
  onClose: () => void;
  onMarkedStopped: (snapshot: RunSnapshot) => void;
  onStopAgain: () => void;
  onUnauthorized: () => void;
}) {
  const [leftover, setLeftover] = useState<ServiceLeftover | null>(null);
  const [checking, setChecking] = useState(true);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failed = useCallback(
    (caught: unknown) => {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
    },
    [onUnauthorized],
  );

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setLeftover(
        await apiGet(`/api/services/${service.id}/leftover`, (value) =>
          ServiceLeftoverResponseSchema.parse(value),
        ),
      );
    } catch (caught) {
      failed(caught);
    } finally {
      setChecking(false);
    }
  }, [service.id, failed]);

  useEffect(() => {
    void check();
  }, [check]);

  async function markStopped() {
    setMarking(true);
    setError(null);
    try {
      const { snapshot } = await apiPost(
        `/api/services/${service.id}/mark-stopped`,
        {},
        (value) => RunSnapshotResponseSchema.parse(value),
        csrfToken,
      );
      onMarkedStopped(snapshot);
    } catch (caught) {
      failed(caught);
      setMarking(false);
    }
  }

  const somethingLeft =
    leftover !== null && (leftover.processRunning === true || leftover.port.status === "in_use");

  return (
    <Dialog onClose={onClose} labelledBy="leftover-title">
      <div className="dialog-form">
        <h2 id="leftover-title">Is {title} still running?</h2>
        <p className="hint">
          DevDock lost track of this script. It won't stop or take over a program it can't prove it
          started, so here is what it can see — you decide.
        </p>
        {leftover === null ? (
          <p className="hint" aria-live="polite">
            {checking ? "Checking…" : ""}
          </p>
        ) : (
          <ul className="checks" aria-label="What DevDock can see">
            <li>
              <span>{leftover.pid === null ? "Process" : <>Process number {leftover.pid}</>}</span>
              <span className={leftover.processRunning === true ? "bad" : "ok"}>
                {leftover.pid === null
                  ? "Not recorded"
                  : leftover.processRunning === true
                    ? "A program with this number is running"
                    : leftover.processRunning === false
                      ? "Not running"
                      : "Couldn't tell"}
              </span>
            </li>
            <li>
              <span>
                {leftover.port.status === "not_configured" ? "Port" : `Port ${leftover.port.port}`}
              </span>
              <span className={leftover.port.status === "in_use" ? "bad" : "ok"}>
                {leftover.port.status === "not_configured"
                  ? "Not set"
                  : leftover.port.status === "in_use"
                    ? "In use"
                    : leftover.port.status === "available"
                      ? "Free"
                      : "Couldn't tell"}
              </span>
            </li>
          </ul>
        )}
        {leftover === null ? null : !leftover.canMarkStopped ? (
          <p className="hint">
            DevDock is still holding this run. Try stopping it again; if that keeps failing, restart
            DevDock.
          </p>
        ) : somethingLeft ? (
          <p className="hint">
            It may still be running — or another program may have reused the number or port. If it's
            still running, close it yourself (for example close its terminal window, or end it in
            Task Manager), then press <strong>Check again</strong>.
          </p>
        ) : (
          <p className="hint">Nothing seems to be left. Mark it as stopped to use it again.</p>
        )}
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
            onClick={() => void check()}
            disabled={checking}
          >
            <Icon name="redo" />
            {checking ? "Checking…" : "Check again"}
          </button>
          <button className="btn ghost" type="button" onClick={onClose}>
            Close
          </button>
          {leftover === null ? null : leftover.canMarkStopped ? (
            <button
              className={somethingLeft ? "btn danger-soft" : "btn primary"}
              type="button"
              onClick={() => void markStopped()}
              disabled={marking || checking}
            >
              <Icon name="check" />
              {marking
                ? "Saving…"
                : somethingLeft
                  ? "It's closed — mark as stopped"
                  : "Mark as stopped"}
            </button>
          ) : (
            <button className="btn primary" type="button" onClick={onStopAgain}>
              <Icon name="stop" />
              Stop again
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
