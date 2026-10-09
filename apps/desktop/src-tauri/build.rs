fn main() {
    // Generates allow-<command> permissions for the app's own commands; capabilities grant them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "request_pairing_code",
            "quit_app",
            "restart_app",
        ]),
    ))
    .expect("failed to run tauri-build");
}
