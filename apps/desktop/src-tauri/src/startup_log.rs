//! An optional startup trace for troubleshooting. When `DEVDOCK_SHELL_LOG` names a file, the shell
//! appends one line per startup step to it, with the milliseconds since the shell started. It
//! records paths and steps only, never the pairing code.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::OnceLock;
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();

pub fn note(message: impl AsRef<str>) {
    let elapsed = STARTED.get_or_init(Instant::now).elapsed().as_millis();
    let Some(path) = std::env::var_os("DEVDOCK_SHELL_LOG") else {
        return;
    };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{elapsed} ms {}", message.as_ref());
    }
}
