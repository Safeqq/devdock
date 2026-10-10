// Release builds are GUI apps without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sidecar;

use sidecar::Sidecar;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const MAIN_WINDOW: &str = "main";
const ERROR_WINDOW: &str = "error";
/// Passed to a second launch to stop the running app, for example by an uninstaller.
const QUIT_ARGUMENT: &str = "--quit";

/// Gives the dashboard a fresh pairing code after its session ended, so the window signs back in
/// without the manual pairing form.
#[tauri::command]
async fn request_pairing_code(sidecar: State<'_, Sidecar>) -> Result<String, String> {
    sidecar.request_pairing_code()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    // Restarting from the main thread skips RunEvent::Exit, so release what that event would:
    // the daemon (and its instance lock) and the single-instance mutex the new process checks.
    if let Some(sidecar) = app.try_state::<Sidecar>() {
        sidecar.stop();
    }
    tauri_plugin_single_instance::destroy(&app);
    app.restart();
}

/// Accepts only plain http(s) addresses on this computer, without credentials. The dashboard checks
/// this too; the shell checks again because the page is served over the network stack.
fn loopback_app_url(value: &str) -> Option<Url> {
    let url = Url::parse(value).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let plain = url.username().is_empty() && url.password().is_none();
    (matches!(url.scheme(), "http" | "https") && loopback && plain).then_some(url)
}

/// Opens a running project's address in the user's default browser, outside the DevDock window.
#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
    let url = loopback_app_url(&url).ok_or("Only addresses on this computer can be opened")?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
}

/// Shows a project folder in the file manager. Only existing directories are accepted, so the page
/// cannot use this to launch a program.
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let folder = std::path::Path::new(&path);
    let is_dir = std::fs::metadata(folder).is_ok_and(|details| details.is_dir());
    if !folder.is_absolute() || !is_dir {
        return Err("Only existing folders can be opened".into());
    }
    tauri_plugin_opener::open_path(folder, None::<&str>).map_err(|error| error.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Replaces the dashboard with a local page explaining why DevDock cannot run, offering to retry
/// or close.
fn show_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.destroy();
    }
    if let Some(window) = app.get_webview_window(ERROR_WINDOW) {
        let _ = window.set_focus();
        return;
    }
    let script = format!(
        "window.__DEVDOCK_ERROR__ = {};",
        serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into())
    );
    let Ok(window) =
        WebviewWindowBuilder::new(app, ERROR_WINDOW, WebviewUrl::App("error.html".into()))
            .title("DevDock")
            .inner_size(560.0, 340.0)
            .resizable(false)
            .initialization_script(script)
            .build()
    else {
        app.exit(1);
        return;
    };
    // There is nothing left to keep in the tray once this window is closed.
    let exit_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            exit_handle.exit(1);
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open DevDock", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        "Quit DevDock (stops all services)",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("devdock")
        .tooltip("DevDock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn open_dashboard(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let exit_handle = app.clone();
    let (sidecar, ready) = Sidecar::start(move || {
        let handle = exit_handle.clone();
        let _ = exit_handle.run_on_main_thread(move || {
            show_error(
                &handle,
                "The DevDock engine stopped unexpectedly. Services it was running may have stopped too.",
            );
        });
    })?;
    app.manage(sidecar);
    let origin = Url::parse(&ready.origin)?;

    // Native features are granted only to the exact daemon origin, decided at runtime because the
    // daemon listens on a random loopback port.
    app.add_capability(
        CapabilityBuilder::new("daemon-origin")
            .remote(format!("{}/*", ready.origin))
            .local(false)
            .window(MAIN_WINDOW)
            .permission("core:default")
            .permission("dialog:allow-open")
            .permission("allow-request-pairing-code")
            .permission("allow-open-in-browser")
            .permission("allow-open-folder"),
    )?;

    // The single-use pairing code reaches the page through an initialization script, never through
    // the URL. serde_json produces a safely quoted JavaScript string literal.
    let pairing = format!(
        "window.__DEVDOCK_DESKTOP__ = {{ pairingCode: {} }};",
        serde_json::to_string(&ready.pairing_code)?
    );
    let allowed_origin = origin.origin();
    let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(origin))
        .title("DevDock")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 640.0)
        .initialization_script(pairing)
        // Keep the window on the daemon's dashboard; anything else is refused.
        .on_navigation(move |url| url.origin() == allowed_origin)
        .build()?;
    // Closing the window keeps DevDock and its services running in the tray.
    let hide_target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hide_target.hide();
        }
    });
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // Must be registered first: a second launch hands its arguments to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|argument| argument == QUIT_ARGUMENT) {
                app.exit(0);
            } else {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            request_pairing_code,
            quit_app,
            restart_app,
            open_in_browser,
            open_folder
        ])
        .setup(|app| {
            // `--quit` with no running instance has nothing to stop.
            if std::env::args().any(|argument| argument == QUIT_ARGUMENT) {
                app.handle().exit(0);
                return Ok(());
            }
            build_tray(app.handle())?;
            if let Err(error) = open_dashboard(app.handle()) {
                show_error(app.handle(), &error.to_string());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("DevDock failed to start");

    app.run(|handle, event| match event {
        // Without a visible window Tauri would exit; DevDock stays in the tray until Quit.
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => {
            if let Some(sidecar) = handle.try_state::<Sidecar>() {
                sidecar.stop();
            }
        }
        _ => {}
    });
}
