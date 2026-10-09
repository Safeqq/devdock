// Shows the reason DevDock could not run and wires the retry and close buttons to the shell.
const message = window.__DEVDOCK_ERROR__;
if (typeof message === "string" && message.length > 0) {
  document.getElementById("message").textContent = message;
}
const invoke = window.__TAURI__?.core?.invoke;
document.getElementById("retry").addEventListener("click", () => invoke?.("restart_app"));
document.getElementById("close").addEventListener("click", () => invoke?.("quit_app"));
