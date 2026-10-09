//! Starts the DevDock daemon as a child process and talks to it over its stdin control pipe.
//!
//! The daemon prints JSON lines on stdout. The shell waits for `registry-api-ready` to learn the
//! loopback origin and the single-use pairing code, then keeps draining stdout so the pipe never
//! fills. Closing stdin, or this process dying, makes the daemon shut down on its own.

use std::error::Error;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const PAIRING_CODE_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

pub struct Ready {
    pub origin: String,
    pub pairing_code: String,
}

/// Owns the daemon process for the lifetime of the app.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    pending_code: Arc<Mutex<Option<mpsc::Sender<String>>>>,
    stopping: Arc<AtomicBool>,
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
    /// Starts the daemon and waits for it to become ready. `on_unexpected_exit` runs on the
    /// reader thread if the daemon's output ends without the shell having asked it to stop.
    pub fn start(
        on_unexpected_exit: impl FnOnce() + Send + 'static,
    ) -> Result<(Sidecar, Ready), Box<dyn Error>> {
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
            .map_err(|error| format!("Could not start the DevDock engine: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or("The DevDock engine has no output pipe.")?;
        let stdin = child.stdin.take();

        let pending_code: Arc<Mutex<Option<mpsc::Sender<String>>>> = Arc::new(Mutex::new(None));
        let stopping = Arc::new(AtomicBool::new(false));
        let (ready_sender, ready_receiver) = mpsc::channel::<Result<Ready, String>>();
        let reader_pending = Arc::clone(&pending_code);
        let reader_stopping = Arc::clone(&stopping);
        thread::spawn(move || {
            let mut ready_sender = Some(ready_sender);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match event.get("type").and_then(|kind| kind.as_str()) {
                    Some("registry-api-ready") => {
                        let result = match (
                            text_field(&event, "origin"),
                            text_field(&event, "pairingCode"),
                        ) {
                            (Some(origin), Some(pairing_code)) => Ok(Ready {
                                origin,
                                pairing_code,
                            }),
                            _ => Err("The DevDock engine sent an incomplete ready event.".into()),
                        };
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(result);
                        }
                    }
                    Some("registry-api-error") => {
                        let message = text_field(&event, "message")
                            .unwrap_or_else(|| "The DevDock engine reported an error.".into());
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Err(message));
                        }
                    }
                    Some("pairing-code") => {
                        if let (Some(code), Some(sender)) = (
                            text_field(&event, "pairingCode"),
                            reader_pending.lock().unwrap().take(),
                        ) {
                            let _ = sender.send(code);
                        }
                    }
                    _ => {}
                }
            }
            // Output ended: the daemon exited. Before readiness this is a start failure; after
            // it, an exit the shell did not request means the engine stopped unexpectedly.
            if let Some(sender) = ready_sender.take() {
                let _ = sender.send(Err("The DevDock engine stopped while starting.".into()));
            } else if !reader_stopping.load(Ordering::SeqCst) {
                on_unexpected_exit();
            }
        });

        let sidecar = Sidecar {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            pending_code,
            stopping,
        };
        let ready = match ready_receiver.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(ready)) => ready,
            Ok(Err(message)) => {
                sidecar.stop();
                return Err(message.into());
            }
            Err(_) => {
                sidecar.stop();
                return Err("The DevDock engine did not start in time.".into());
            }
        };
        Ok((sidecar, ready))
    }

    /// Asks the daemon for a fresh single-use pairing code, used when the window's session ended.
    pub fn request_pairing_code(&self) -> Result<String, String> {
        let (sender, receiver) = mpsc::channel();
        *self.pending_code.lock().unwrap() = Some(sender);
        {
            let mut stdin = self.stdin.lock().unwrap();
            let pipe = stdin.as_mut().ok_or("The DevDock engine is not running.")?;
            pipe.write_all(b"{\"type\":\"issue-pairing-code\"}\n")
                .and_then(|()| pipe.flush())
                .map_err(|error| format!("Could not reach the DevDock engine: {error}"))?;
        }
        receiver
            .recv_timeout(PAIRING_CODE_TIMEOUT)
            .map_err(|_| "The DevDock engine did not answer.".to_string())
    }

    /// Asks the daemon to stop its services and exit, then waits for it. Falls back to killing
    /// the process only if it does not exit within the timeout.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
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
