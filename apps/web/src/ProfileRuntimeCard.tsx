import {
  type ProfileConfig,
  type ProfileOperationSnapshot,
  ProfileRuntimeStatusResponseSchema,
  ProfileStartResponseSchema,
  ProfileStopResponseSchema,
} from "@devdock/contracts";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "./api";

interface ProfileRuntimeCardProps {
  readonly profile: ProfileConfig;
  readonly serviceNames: ReadonlyMap<string, string>;
  readonly csrfToken: string;
  readonly onUnauthorized: () => void;
  readonly onError: (caught: unknown) => void;
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./u, (first) => first.toUpperCase());
}

export function ProfileRuntimeCard({
  profile,
  serviceNames,
  csrfToken,
  onUnauthorized,
  onError,
}: ProfileRuntimeCardProps) {
  const [snapshot, setSnapshot] = useState<ProfileOperationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await apiGet(
          `/api/profiles/${profile.id}/status`,
          (value) => ProfileRuntimeStatusResponseSchema.parse(value),
          signal,
        );
        setSnapshot(response.snapshot);
      } catch (caught) {
        if (signal?.aborted) return;
        if (
          typeof caught === "object" &&
          caught !== null &&
          "status" in caught &&
          caught.status === 401
        ) {
          onUnauthorized();
        } else {
          onError(caught);
        }
      }
    },
    [onError, onUnauthorized, profile.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus]);

  useEffect(() => {
    if (
      snapshot?.state !== "starting" &&
      snapshot?.state !== "ready" &&
      snapshot?.state !== "stopping"
    )
      return;
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      await loadStatus(controller.signal);
      if (!controller.signal.aborted)
        timer = window.setTimeout(() => void poll(), snapshot.state === "ready" ? 1_000 : 250);
    };
    timer = window.setTimeout(() => void poll(), snapshot.state === "ready" ? 1_000 : 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadStatus, snapshot?.state]);

  async function start() {
    setBusy(true);
    try {
      const response = await apiPost(
        `/api/profiles/${profile.id}/start`,
        {},
        (value) => ProfileStartResponseSchema.parse(value),
        csrfToken,
      );
      setSnapshot(response.outcome.snapshot);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      const response = await apiPost(
        `/api/profiles/${profile.id}/stop`,
        {},
        (value) => ProfileStopResponseSchema.parse(value),
        csrfToken,
      );
      setSnapshot(response.outcome.snapshot);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  }

  const active =
    snapshot?.state === "starting" || snapshot?.state === "ready" || snapshot?.state === "stopping";
  const degradedWithRetainedServices =
    snapshot?.state === "degraded" &&
    snapshot.services.some(
      (service) =>
        service.origin !== "pending" && (service.state === "ready" || service.state === "failed"),
    );

  return (
    <article className="profile-card">
      <div className="profile-card-heading">
        <div>
          <span className="eyebrow">Profile</span>
          <h4>{profile.displayName}</h4>
        </div>
        <span className={`state-pill ${snapshot?.state ?? "idle"}`}>
          {label(snapshot?.state ?? "idle")}
        </span>
      </div>
      <ol className="profile-service-status">
        {(snapshot?.services ?? profile.services).map((entry) => {
          const state = "state" in entry ? entry.state : "pending";
          const origin = "origin" in entry ? entry.origin : "pending";
          return (
            <li key={entry.serviceId}>
              <strong>{serviceNames.get(entry.serviceId) ?? entry.serviceId}</strong>
              <span>
                {label(state)}
                {origin === "pre_existing" ? " · preserved if rollback runs" : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {snapshot?.state === "degraded" ? (
        <p className="message error" role="status">
          Profile degraded: {label(snapshot.failureReason ?? "startup failed")}
        </p>
      ) : null}
      <div className="action-row">
        <button
          className="primary"
          type="button"
          disabled={busy || active || degradedWithRetainedServices}
          onClick={() => void start()}
        >
          {snapshot?.state === "degraded" ? "Retry profile" : "Start profile"}
        </button>
        <button
          className="quiet danger"
          type="button"
          disabled={busy || (!active && !degradedWithRetainedServices)}
          onClick={() => void stop()}
        >
          Stop profile
        </button>
      </div>
    </article>
  );
}
