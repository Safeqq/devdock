import { ProfileResponseSchema } from "@devdock/contracts";
import { type FormEvent, useState } from "react";
import { ApiError, apiPost, friendlyError, type Profile, type Service } from "./api";
import { Dialog } from "./Dialog";
import { Icon } from "./icons";
import type { ScriptEntry } from "./ScriptCard";

// Groups start several scripts with one click. Scripts are started in the order they are picked;
// "one after another" makes each wait until the previous one is ready.
export function NewGroupDialog({
  entries,
  projectId,
  csrfToken,
  ensureService,
  onClose,
  onCreated,
  onUnauthorized,
}: {
  entries: readonly ScriptEntry[];
  projectId: string;
  csrfToken: string;
  ensureService: (entry: ScriptEntry) => Promise<Service>;
  onClose: () => void;
  onCreated: (profile: Profile) => void;
  onUnauthorized: () => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [chained, setChained] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string, selected: boolean) {
    setPicked((current) =>
      selected ? [...current, key] : current.filter((entry) => entry !== key),
    );
  }

  async function create(event: FormEvent<HTMLFormElement>) {
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
      const { profile } = await apiPost(
        `/api/projects/${projectId}/profiles`,
        {
          displayName: name.trim(),
          services: services.map((service, index) => ({
            serviceId: service.id,
            dependsOn: chained && index > 0 ? [(services[index - 1] as Service).id] : [],
          })),
        },
        (value) => ProfileResponseSchema.parse(value),
        csrfToken,
      );
      onCreated(profile);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
      else setError(friendlyError(caught).message);
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy="group-title">
      <div className="modal-icon">
        <Icon name="layers" />
      </div>
      <form className="dialog-form" onSubmit={(event) => void create(event)}>
        <h2 id="group-title">New group</h2>
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
        </fieldset>
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
            disabled={busy || name.trim() === "" || picked.length === 0}
          >
            <Icon name="plus" />
            {busy ? "Creating…" : "Create group"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
