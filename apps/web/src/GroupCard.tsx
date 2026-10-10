import type { Profile, ProfileOperationSnapshot } from "./api";
import { Icon } from "./icons";
import { StatusPill } from "./ScriptCard";
import { groupOrder, groupState } from "./status";

// "Starts api, then dev once api is ready" — the order a group follows, in words.
function describe(profile: Profile, names: ReadonlyMap<string, string>) {
  const order = groupOrder(profile);
  const name = (id: string) => <code key={id}>{names.get(id) ?? "a removed script"}</code>;
  if (order.length === 1) return <>Starts {name(order[0] as string)}</>;
  const chained = profile.services.every((entry) => {
    const position = order.indexOf(entry.serviceId);
    return position === 0
      ? entry.dependsOn.length === 0
      : entry.dependsOn.length === 1 && entry.dependsOn[0] === order[position - 1];
  });
  if (profile.services.every((entry) => entry.dependsOn.length === 0)) {
    return (
      <>
        Starts{" "}
        {order.map((id, index) => (
          <span key={id}>
            {index === 0 ? "" : index === order.length - 1 ? " and " : ", "}
            {name(id)}
          </span>
        ))}{" "}
        together
      </>
    );
  }
  if (chained) {
    return (
      <>
        Starts{" "}
        {order.map((id, index) => (
          <span key={id}>
            {index === 0 ? "" : ", then "}
            {name(id)}
          </span>
        ))}
        , each once the one before is ready
      </>
    );
  }
  return <>Starts {order.length} scripts, waiting for the ones they depend on</>;
}

export function GroupCard({
  profile,
  snapshot,
  names,
  busy,
  onStart,
  onStop,
  onEdit,
}: {
  profile: Profile;
  snapshot: ProfileOperationSnapshot | null;
  names: ReadonlyMap<string, string>;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onEdit: () => void;
}) {
  const state = groupState(snapshot, names);
  return (
    <article className="card group-card" aria-label={`${profile.displayName} group`}>
      <div className="card-head">
        <h3 className="plain">
          <Icon name="layers" />
          {profile.displayName}
        </h3>
        <span className="tag soft">Group</span>
      </div>
      <p className="desc">{describe(profile, names)}</p>
      <p className="meta">One click to start or stop them all.</p>
      {state.why === null ? null : (
        <p className="why">
          <Icon name="alert" />
          <span>{state.why}</span>
        </p>
      )}
      <div className="card-foot">
        <StatusPill tone={state.tone} label={state.label} />
        <div className="actions">
          {state.canStart ? (
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={onStart}
              aria-label={`${state.startLabel}: ${profile.displayName}`}
            >
              <Icon name={state.tone === "failed" ? "redo" : "play"} />
              {state.startLabel}
            </button>
          ) : null}
          {state.canStop ? (
            <button
              className="btn danger-soft"
              type="button"
              disabled={busy}
              onClick={onStop}
              aria-label={`Stop group: ${profile.displayName}`}
            >
              <Icon name="stop" />
              Stop group
            </button>
          ) : null}
          <button
            className="btn icon-only ghost"
            type="button"
            onClick={onEdit}
            // A running group keeps its members until it stops, so it is edited only when idle.
            disabled={!state.canStart}
            aria-label={`Edit group: ${profile.displayName}`}
            title={state.canStart ? "Edit group" : "Stop the group to edit it"}
          >
            <Icon name="gear" />
          </button>
        </div>
      </div>
    </article>
  );
}
