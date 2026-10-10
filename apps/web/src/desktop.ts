// Bridge to the Tauri desktop shell. Outside the desktop app every helper reports that it is
// unavailable, and the dashboard falls back to what a browser tab can do.

declare global {
  interface Window {
    // Set by the desktop shell's initialization script; never part of a URL or stored on disk.
    __DEVDOCK_DESKTOP__?: { pairingCode?: string };
    // The Tauri desktop shell's global API, present only inside the desktop app.
    __TAURI__?: {
      core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
  }
}

function invoker() {
  const invoke = window.__TAURI__?.core?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

export function isDesktop(): boolean {
  return invoker() !== null;
}

export async function invokeDesktop(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const invoke = invoker();
  if (invoke === null) throw new Error("DevDock desktop features are unavailable");
  return invoke(command, args);
}

// Shows the native folder picker. Resolves to null when the user cancels.
export async function pickFolder(): Promise<string | null> {
  const picked = await invokeDesktop("plugin:dialog|open", {
    options: { directory: true, title: "Choose a project folder" },
  });
  return typeof picked === "string" && picked.length > 0 ? picked : null;
}

// Opens a loopback address in the user's default browser; the shell checks it again.
export async function openInBrowser(url: string): Promise<void> {
  await invokeDesktop("open_in_browser", { url });
}

// Shows a project folder in the system file manager.
export async function openFolder(path: string): Promise<void> {
  await invokeDesktop("open_folder", { path });
}
