# Install DevDock on Windows

DevDock's desktop app runs and stops your Node.js project scripts from one window. This guide covers installing it, the Windows warning you will see, updating, uninstalling, and what to do when it does not start.

It is tested on Windows 11 x64. Other Windows versions and Arm PCs have not been verified.

## Install

1. Download `DevDock_<version>_x64-setup.exe` and its `.sha256` file from the [GitHub releases page](https://github.com/Safeqq/devdock/releases).
2. Optionally check the download in PowerShell, in the folder you saved it to. Both lines must show the same hash:

   ```powershell
   (Get-FileHash .\DevDock_<version>_x64-setup.exe -Algorithm SHA256).Hash.ToLower()
   (Get-Content .\DevDock_<version>_x64-setup.exe.sha256).Split(" ")[0]
   ```

3. Double-click the installer. Windows will probably show **Windows protected your PC**. Click **More info**, check that the app is `DevDock_<version>_x64-setup.exe`, then click **Run anyway**. See [Why Windows warns you](#why-windows-warns-you) below.
4. Follow the installer: accept the MIT license, keep or change the folder, and finish. You do not need administrator rights. On the last page you can create a desktop shortcut and start DevDock right away.

DevDock then appears in the Start menu as **DevDock**.

### Why Windows warns you

The installer is not code-signed yet, so SmartScreen does not know its publisher. The warning does not mean anything harmful was found. If you prefer not to rely on it, compare the SHA-256 hash as shown above before running the installer.

## What it installs

The installer adds about 150 MB for the current user, by default in `%LOCALAPPDATA%\DevDock`:

| Item | What it is |
| --- | --- |
| `devdock-desktop.exe` | The DevDock app. |
| `runtime\` | Node.js 24.21.0 with npm, the official Windows build. |
| `engine\` | DevDock's engine, which runs and supervises your scripts. |
| `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` | DevDock's MIT license and the licenses of the software it includes. |

When DevDock runs a script, it uses the first Node.js and npm on your `PATH`, so your projects keep the versions you installed. If your computer has no Node.js, DevDock uses its own copy. The app's footer shows which one it uses.

DevDock keeps its list of projects and settings in `registry.sqlite` in the same `%LOCALAPPDATA%\DevDock` folder. The window's own browser data lives in `%LOCALAPPDATA%\com.safeqq.devdock`.

## Use

Open **DevDock** from the Start menu and choose a project folder. Closing the window keeps DevDock and your scripts running in the notification area (the `^` next to the clock). To stop everything, right-click the DevDock icon there and choose **Stop all scripts**, or **Quit DevDock (stops all scripts)**.

DevDock runs your scripts with your own user account, so add only projects you trust.

## Update

Download the newer installer and run it. If DevDock is running, the installer first asks it to quit, which stops your scripts, then replaces the program files. Your projects and settings stay.

## Uninstall

Open **Settings → Apps → Installed apps**, find **DevDock**, and choose **Uninstall**. Alternatively, run `uninstall.exe` in the install folder.

- If DevDock is running, the uninstaller first asks it to quit, which stops your scripts.
- **Delete the application data** removes only the window's browser data in `%LOCALAPPDATA%\com.safeqq.devdock`.
- Your projects and settings in `%LOCALAPPDATA%\DevDock\registry.sqlite` are always kept, so reinstalling brings them back. To remove them too, delete the `%LOCALAPPDATA%\DevDock` folder after uninstalling.
- Uninstalling never touches your project folders.

## When DevDock does not start

- **"Another DevDock instance is already using this data directory".** The command-line DevDock (`devdock`) or another copy of the app is running with the same data. Stop it and press **Try again**.
- **Nothing appears.** DevDock may already be running in the notification area; starting it again shows the existing window. If it still does not appear, record a startup trace. In PowerShell:

  ```powershell
  $env:DEVDOCK_SHELL_LOG = "$env:TEMP\devdock-shell.log"
  & "$env:LOCALAPPDATA\DevDock\devdock-desktop.exe"
  ```

  After a minute, open `%TEMP%\devdock-shell.log`. Each line is one startup step, for example `engine ready` or `main window created`. Include the file when you [report the problem](https://github.com/Safeqq/devdock/issues). It lists paths and steps only, no project data or secrets.
- **The window opens but stays blank.** DevDock needs the Microsoft Edge WebView2 Runtime, which Windows 11 already includes. On older systems the installer downloads it, so it needs internet access during installation.

More symptoms and fixes are in [troubleshooting](troubleshooting.md).
