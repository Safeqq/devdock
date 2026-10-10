import { SessionResponseSchema } from "@devdock/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiPost, friendlyError } from "./api";
import { invokeDesktop, isDesktop } from "./desktop";
import { Icon, Logo } from "./icons";
import { Workspace } from "./Workspace";

type SessionState =
  | { kind: "checking" }
  | { kind: "pairing" }
  | { kind: "ready"; csrfToken: string }
  | { kind: "error"; message: string };

// Reads the single-use pairing code injected by the desktop shell and removes it, so it is
// gone from the page once used and a reload cannot replay it.
function takeDesktopPairingCode(): string | null {
  const desktop = window.__DEVDOCK_DESKTOP__;
  if (desktop === undefined) return null;
  const code = desktop.pairingCode;
  delete desktop.pairingCode;
  return typeof code === "string" && code.length > 0 ? code : null;
}

// Asks the desktop shell for a fresh single-use pairing code. Returns null outside the desktop app.
async function requestDesktopPairingCode(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    const code = await invokeDesktop("request_pairing_code");
    return typeof code === "string" && code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

async function pairWithCode(code: string): Promise<string | null> {
  try {
    const paired = await apiPost("/api/pair", { code }, (value) =>
      SessionResponseSchema.parse(value),
    );
    return paired.csrfToken;
  } catch {
    return null;
  }
}

// Signs the desktop window in without the pairing form. The startup code injected by the shell is
// tried first; it is re-injected on every reload, so once it is used up the shell is asked for a
// fresh one. Resolves to the CSRF token, or null so the caller shows the manual form instead.
async function pairDesktopWindow(): Promise<string | null> {
  const injected = takeDesktopPairingCode();
  if (injected !== null) {
    const csrfToken = await pairWithCode(injected);
    if (csrfToken !== null) return csrfToken;
  }
  const fresh = await requestDesktopPairingCode();
  return fresh === null ? null : pairWithCode(fresh);
}

const pairingMessages: Record<string, string> = {
  PAIRING_CODE_INVALID: "That code doesn't match. Check the code in the DevDock terminal.",
  PAIRING_UNAVAILABLE:
    "This code has expired or was already used. Restart DevDock to get a new one.",
  PAIRING_RATE_LIMITED: "Too many wrong codes. Restart DevDock to get a new one.",
};

// Only for the browser dashboard of the command-line DevDock; the desktop app signs in by itself.
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
      setError(
        caught instanceof ApiError
          ? (pairingMessages[caught.code] ?? friendlyError(caught).message)
          : friendlyError(caught).message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="splash">
      <section className="pairing" aria-labelledby="pairing-title">
        <Logo big />
        <h1 id="pairing-title">Pair this browser</h1>
        <p className="hint">
          Enter the one-time code printed in the terminal where DevDock is running. It stays in this
          form and is never put in the address bar.
        </p>
        <form className="dialog-form" onSubmit={(event) => void submit(event)}>
          <label className="field">
            Pairing code
            <input
              type="password"
              autoComplete="off"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
              maxLength={128}
            />
          </label>
          {error === null ? null : (
            <p className="form-error" role="alert">
              <Icon name="alert" />
              {error}
            </p>
          )}
          <button className="btn primary" type="submit" disabled={busy || code.trim() === ""}>
            {busy ? "Pairing…" : "Pair browser"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: "checking" });
  // Several requests can fail with 401 at once; one sign-in serves them all, because each new
  // desktop pairing code invalidates the previous one.
  const signingIn = useRef<Promise<void> | null>(null);
  const signIn = useCallback((isCurrent: () => boolean) => {
    signingIn.current ??= pairDesktopWindow()
      .then((csrfToken) => {
        if (!isCurrent()) return;
        setSession(csrfToken === null ? { kind: "pairing" } : { kind: "ready", csrfToken });
      })
      .finally(() => {
        signingIn.current = null;
      });
    return signingIn.current;
  }, []);
  const onUnauthorized = useCallback(() => {
    setSession({ kind: "checking" });
    void signIn(() => true);
  }, [signIn]);

  useEffect(() => {
    const controller = new AbortController();
    void apiGet("/api/session", (value) => SessionResponseSchema.parse(value), controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setSession({ kind: "ready", csrfToken: result.csrfToken });
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (!(caught instanceof ApiError && caught.status === 401)) {
          setSession({ kind: "error", message: friendlyError(caught).message });
          return;
        }
        void signIn(() => !controller.signal.aborted);
      });
    return () => controller.abort();
  }, [signIn]);

  if (session.kind === "ready") {
    return <Workspace csrfToken={session.csrfToken} onUnauthorized={onUnauthorized} />;
  }
  if (session.kind === "pairing") {
    return <PairingView onPaired={(csrfToken) => setSession({ kind: "ready", csrfToken })} />;
  }
  return (
    <main className="splash" aria-live="polite">
      <Logo big />
      {session.kind === "checking" ? (
        <p>Starting DevDock…</p>
      ) : (
        <>
          <p role="alert">{session.message}</p>
          <button className="btn secondary" type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </>
      )}
    </main>
  );
}
