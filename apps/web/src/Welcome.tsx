import { Dialog } from "./Dialog";
import { isDesktop } from "./desktop";
import { Icon, Logo } from "./icons";

function ScriptExplainer() {
  return (
    <div className="explain">
      <Icon name="help" />
      <p>
        <strong>What's a script?</strong> Projects list their commands in a file called{" "}
        <code>package.json</code> — things like <code>dev</code> (starts your app while you work) or{" "}
        <code>build</code> (prepares it for release). DevDock turns each one into a button.
      </p>
    </div>
  );
}

function Steps() {
  return (
    <ol className="step-cards">
      <li className="step">
        <span className="step-icon">
          <Icon name="folder" />
        </span>
        <span className="step-num">Step 1</span>
        <strong>Add a project</strong>
        <span>
          Pick the folder that contains <code>package.json</code>.
        </span>
      </li>
      <li className="step">
        <span className="step-icon">
          <Icon name="play" />
        </span>
        <span className="step-num">Step 2</span>
        <strong>Press Start</strong>
        <span>DevDock runs the script and shows what it prints.</span>
      </li>
      <li className="step">
        <span className="step-icon">
          <Icon name="globe" />
        </span>
        <span className="step-num">Step 3</span>
        <strong>Open your app</strong>
        <span>
          When it says <em>Ready</em>, open it in your browser.
        </span>
      </li>
    </ol>
  );
}

function TrustNote() {
  return (
    <p className="trust">
      <Icon name="alert" />
      Scripts run with your account's permissions. Only add projects you trust.
    </p>
  );
}

function today(): string {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// First launch: nothing has been added yet. Laid out like a front page: a dateline, a headline,
// what a script is, the three steps, and one obvious button.
export function Welcome({ onAddProject }: { onAddProject: () => void }) {
  return (
    <main className="welcome">
      <div className="welcome-inner">
        <p className="dateline">
          <span>DevDock · your local script runner</span>
          <span>{today()}</span>
          <span>No terminal needed</span>
        </p>
        <div className="welcome-head">
          <Logo big />
          <h1>Welcome to DevDock</h1>
          <p className="lead">
            Run your project's scripts with a click — no terminal windows to juggle.
          </p>
        </div>
        <div className="double-rule" aria-hidden="true" />
        <ScriptExplainer />
        <Steps />
        <div className="welcome-cta">
          <button className="btn primary large" type="button" onClick={onAddProject}>
            <Icon name="folder" />
            Choose a project folder
          </button>
          <TrustNote />
        </div>
      </div>
    </main>
  );
}

// The same explanation, reachable later from "How DevDock works".
export function HowItWorksDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog onClose={onClose} labelledBy="how-title">
      <div className="how">
        <h2 id="how-title">How DevDock works</h2>
        <ScriptExplainer />
        <Steps />
        <ul className="how-more">
          {isDesktop() ? (
            <li>
              <strong>Closing the window</strong> keeps your scripts running. DevDock stays in the
              system tray; choose <em>Quit DevDock</em> there to stop everything.
            </li>
          ) : (
            <li>
              <strong>Closing this tab</strong> keeps your scripts running. They stop when you stop
              DevDock in its terminal.
            </li>
          )}
          <li>
            <strong>Settings</strong> (the gear on a card) are optional. Use them to tell DevDock
            your app's port, when it counts as ready, environment files, and whether to restart it
            after a crash.
          </li>
          <li>
            <strong>Groups</strong> start several scripts with one click, in order — for example an
            API first, then the website that uses it.
          </li>
        </ul>
        <TrustNote />
        <div className="modal-actions">
          <button className="btn primary" type="button" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </Dialog>
  );
}
