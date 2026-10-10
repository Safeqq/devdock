import { DeletedResponseSchema, ProfileResponseSchema } from "@devdock/contracts";
import { type FormEvent, useState } from "react";
import { ApiError, apiPost, friendlyError, type Profile, type Service } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";
import type { ScriptEntry } from "./ScriptCard";
import { groupOrder } from "./status";

// True when each script waits for the one before it, which is what "one after another" saves.
function isChained(profile: Profile): boolean {
  const order = groupOrder(profile);
  return profile.services.every((entry) => {
    const position = order.indexOf(entry.serviceId);
    return position === 0
      ? entry.dependsOn.length === 0
      : entry.dependsOn.length === 1 && entry.dependsOn[0] === order[position - 1];
  });
}

// Groups start several scripts with one click. Scripts are started in the order they are picked;
// "one after another" makes each wait until the previous one is ready. With a profile the dialog
// edits that group and can delete it.
export function GroupDialog({
  entries,
  projectId,
  profile,
  csrfToken,
  ensureService,
  onClose,
  onSaved,
  onDeleted,
  onUnauthorized,
}: {
  entries: readonly ScriptEntry[];
  projectId: string;
  profile?: Profile;
  csrfToken: string;
  ensureService: (entry: ScriptEntry) => Promise<Service>;
  onClose: () => void;
  onSaved: (profile: Profile) => void;
  onDeleted?: (profileId: string) => void;
  onUnauthorized: () => void;
}) {
  const editing = profile !== undefined;
  const [name, setName] = useState(profile?.displayName ?? "");
  const [picked, setPicked] = useState<string[]>(() =>
    profile === undefined
      ? []
      : groupOrder(profile).flatMap((serviceId) => {
          const entry = entries.find((candidate) => candidate.service?.id === serviceId);
          return entry === undefined ? [] : [entry.key];
        }),
  );
  const [chained, setChained] = useState(() =>
    profile === undefined || profile.services.length < 2 ? true : isChained(profile),
  );
  const custom =
    profile !== undefined &&
    !isChained(profile) &&
    profile.services.some((entry) => entry.dependsOn.length > 0);
  const missing =
    profile === undefined
      ? 0
      : profile.services.filter(
          (member) => !entries.some((entry) => entry.service?.id === member.serviceId),
        ).length;
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string, selected: boolean) {
    setPicked((current) =>
      selected ? [...current, key] : current.filter((entry) => entry !== key),
    );
  }

  function failed(caught: unknown) {
    if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
    else setError(friendlyError(caught).message);
    setBusy(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === "" || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const services: Service[] = [];
      for (const key of picked) {
        const entry = entries.find((candidate) => candidate.key === key);
        if (entry !== undefined) services.push(await ensureService(entry));
      }
      const body = {
        displayName: name.trim(),
        services: services.map((service, index) => ({
          serviceId: service.id,
          dependsOn: chained && index > 0 ? [(services[index - 1] as Service).id] : [],
        })),
      };
      const { profile: saved } = await apiPost(
        editing ? `/api/profiles/${profile.id}/update` : `/api/projects/${projectId}/profiles`,
        body,
        (value) => ProfileResponseSchema.parse(value),
        csrfToken,
      );
      onSaved(saved);
    } catch (caught) {
      failed(caught);
    }
  }

  async function remove() {
    if (profile === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(
        `/api/profiles/${profile.id}/delete`,
        {},
        (value) => DeletedResponseSchema.parse(value),
        csrfToken,
      );
      onDeleted?.(profile.id);
    } catch (caught) {
      setConfirmDelete(false);
      failed(caught);
    }
  }

  if (confirmDelete && profile !== undefined) {
    return (
      <Dialog onClose={() => setConfirmDelete(false)} labelledBy="group-delete-title">
        <div className="dialog-form">
          <h2 id="group-delete-title">Delete the group {profile.displayName}?</h2>
          <p className="hint">
            Only the group goes away. Its scripts, their settings, and your files stay as they are.
          </p>
          <div className="modal-actions">
            <button className="btn ghost" type="button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="btn danger-soft"
              type="button"
              disabled={busy}
              onClick={() => void remove()}
            >
              <Icon name="trash" />
              {busy ? "Deleting…" : "Delete group"}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog onClose={onClose} labelledBy="group-title">
      <div className="modal-icon">
        <Icon name="layers" />
      </div>
      <form className="dialog-form" onSubmit={(event) => void save(event)}>
        <h2 id="group-title">{editing ? "Edit group" : "New group"}</h2>
        <p className="hint">
          Start several scripts with one click — for example your API first, then the website that
          uses it.
        </p>
        <label className="field">
          Group name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Full stack"
            maxLength={128}
            required
          />
        </label>
        <fieldset className="pick-list">
          <legend>Scripts to start, in this order</legend>
          {entries.map((entry) => {
            const position = picked.indexOf(entry.key);
            return (
              <label key={entry.key} className="pick">
                <input
                  type="checkbox"
                  checked={position !== -1}
                  onChange={(event) => toggle(entry.key, event.target.checked)}
                />
                <code>{entry.title}</code>
                <span className="pick-desc">{entry.hint.description ?? ""}</span>
                {position === -1 ? null : <span className="order">{position + 1}</span>}
              </label>
            );
          })}
        </fieldset>
        {missing === 0 ? null : (
          <p className="hint">
            {missing === 1
              ? "One script in this group no longer exists, so it was left out."
              : `${missing} scripts in this group no longer exist, so they were left out.`}
          </p>
        )}
        <fieldset className="group-box">
          <legend>How should they start?</legend>
          <label className="radio">
            <input type="radio" name="chain" checked={chained} onChange={() => setChained(true)} />
            One after another — each waits until the one before is ready
          </label>
          <label className="radio">
            <input
              type="radio"
              name="chain"
              checked={!chained}
              onChange={() => setChained(false)}
            />
            All at once
          </label>
          {custom ? (
            <small>
              This group was set up with its own waiting rules. Saving replaces them with the choice
              above.
            </small>
          ) : null}
        </fieldset>
        {error === null ? null : (
          <p className="form-error" role="alert">
            <Icon name="alert" />
            {error}
          </p>
        )}
        <div className="modal-actions">
          {editing ? (
            <button
              className="btn danger-soft push-left"
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" />
              Delete group
            </button>
          ) : null}
          <button className="btn ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="submit"
            disabled={busy || name.trim() === "" || picked.length === 0}
          >
            <Icon name={editing ? "check" : "plus"} />
            {busy ? "Saving…" : editing ? "Save group" : "Create group"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
