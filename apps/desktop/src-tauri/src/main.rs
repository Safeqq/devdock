// Release builds are GUI apps without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::Sidecar;
use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (sidecar, ready) = Sidecar::start()?;
            app.manage(sidecar);
            let origin = Url::parse(&ready.origin)?;

            // Native features are granted only to the exact daemon origin, decided at runtime
            // because the daemon listens on a random loopback port.
            app.add_capability(
                CapabilityBuilder::new("daemon-origin")
                    .remote(format!("{}/*", ready.origin))
                    .local(false)
                    .window("main")
                    .permission("core:default")
                    .permission("dialog:allow-open"),
            )?;

            // The single-use pairing code reaches the page through an initialization script, never
            // through the URL. serde_json produces a safely quoted JavaScript string literal.
            let pairing = format!(
                "window.__DEVDOCK_DESKTOP__ = {{ pairingCode: {} }};",
                serde_json::to_string(&ready.pairing_code)?
            );
            let allowed_origin = origin.origin();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(origin))
                .title("DevDock")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 640.0)
                .initialization_script(pairing)
                // Keep the window on the daemon's dashboard; anything else is refused.
                .on_navigation(move |url| url.origin() == allowed_origin)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("DevDock failed to start");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(sidecar) = handle.try_state::<Sidecar>() {
                sidecar.stop();
            }
        }
    });
}
