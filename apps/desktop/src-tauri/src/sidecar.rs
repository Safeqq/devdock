//! Starts the DevDock daemon as a child process and talks to it over its stdin control pipe.
//!
//! The daemon prints JSON lines on stdout. The shell waits for `registry-api-ready` to learn the
//! loopback origin and the single-use pairing code, then keeps draining stdout so the pipe never
//! fills. Closing stdin, or this process dying, makes the daemon shut down on its own.

use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Ready {
    pub origin: String,
    pub pairing_code: String,
}

/// Owns the daemon process for the lifetime of the app.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

/// The Node.js that runs the daemon. Packaging (stage D4) will point this at a bundled runtime;
/// during development it comes from `DEVDOCK_SIDECAR_NODE` or `node` on PATH.
fn node_executable() -> PathBuf {
    std::env::var_os("DEVDOCK_SIDECAR_NODE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("node"))
}

/// The daemon entry point. Defaults to the workspace build output next to this crate.
fn daemon_entry() -> PathBuf {
    std::env::var_os("DEVDOCK_SIDECAR_ENTRY")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../daemon/dist/registry-api-cli.js")
        })
}

fn text_field(event: &serde_json::Value, name: &str) -> Option<String> {
    event.get(name)?.as_str().map(str::to_owned)
}

impl Sidecar {
    pub fn start() -> Result<(Sidecar, Ready), Box<dyn Error>> {
        let mut command = Command::new(node_executable());
        command
            .arg(daemon_entry())
            .env("DEVDOCK_CONTROL", "stdin")
            .env("DEVDOCK_PORT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: the daemon must not open a console window of its own.
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("could not start the DevDock engine: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("the DevDock engine has no stdout pipe")?;
        let stdin = child.stdin.take();

        let (ready_sender, ready_receiver) = mpsc::channel::<Result<Ready, String>>();
        thread::spawn(move || {
            let mut ready_sender = Some(ready_sender);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let result = match event.get("type").and_then(|kind| kind.as_str()) {
                    Some("registry-api-ready") => {
                        match (
                            text_field(&event, "origin"),
                            text_field(&event, "pairingCode"),
                        ) {
                            (Some(origin), Some(pairing_code)) => Ok(Ready {
                                origin,
                                pairing_code,
                            }),
                            _ => Err("the DevDock engine sent an incomplete ready event".into()),
                        }
                    }
                    Some("registry-api-error") => Err(text_field(&event, "message")
                        .unwrap_or_else(|| "the DevDock engine reported an error".into())),
                    _ => continue,
                };
                if let Some(sender) = ready_sender.take() {
                    let _ = sender.send(result);
                }
            }
        });

        let sidecar = Sidecar {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
        };
        let ready = match ready_receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(ready)) => ready,
            Ok(Err(message)) => {
                sidecar.stop();
                return Err(message.into());
            }
            Err(_) => {
                sidecar.stop();
                return Err("the DevDock engine did not start in time".into());
            }
        };
        Ok((sidecar, ready))
    }

    /// Asks the daemon to stop its services and exit, then waits for it. Falls back to killing
    /// the process only if it does not exit within the timeout.
    pub fn stop(&self) {
        if let Some(mut stdin) = self.stdin.lock().unwrap().take() {
            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
            let _ = stdin.flush();
        }
        let Some(mut child) = self.child.lock().unwrap().take() else {
            return;
        };
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
    }
}
