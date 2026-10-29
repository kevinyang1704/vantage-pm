# Run the Vantage desktop app from source (Windows)

For computers where you can't install the Vantage installer but may install
developer tools. One script sets everything up and starts the app. This copy is
**local-only**: projects are saved on your computer. Teammates can exchange files
using [Share for editing and reviewed merges](local-collaboration.md), without a hosted service.

## Before you start: will your computer allow it?

The desktop app is a program your computer builds and then runs. Some company
policies block running programs you build yourself. If you see "This app has
been blocked by your organization" when the app tries to start, use the
browser version instead: [run-in-browser.md](run-in-browser.md).

## First time

1. Get the code from the **`main`** branch:
   ```
   git clone <your-vantage-pm-repository-url>
   ```
   (No Git yet? On GitHub switch to `main`, then **Code → Download ZIP**, and unzip.)
2. In the `vantage-pm` folder, double-click **`setup-desktop.bat`**.

It checks for, and installs only what's missing:

| Tool | Why |
|---|---|
| Git | getting updates |
| Node.js 24 | builds the app's screens |
| Visual Studio Build Tools (C++) | the compiler Rust uses on Windows (may ask for admin) |
| Rust 1.98.0 (pinned in `src-tauri/rust-toolchain.toml`) | builds the app's core |
| WebView2 | draws the app window (already part of Windows 11) |

then installs the app's locked dependencies and starts Vantage. The first build
takes 5–10 minutes; later starts take seconds.

### If your company installs software its own way

Ask IT to install the tools above (or give you the command), then run:
```
setup-desktop.bat -NoInstall
```
It only checks and tells you exactly what is still missing. If IT has a company
winget source: `setup-desktop.bat -WingetSource <name>`. If the npm registry is
blocked, IT can give you the company registry: `npm config set registry <url>`.

## Every day

Double-click **`start-desktop.bat`**. Close the window to stop.

## Update

```
git pull
```
then double-click `setup-desktop.bat` again (it installs only what changed).

## Your projects

They're saved in your user profile (`%APPDATA%\com.pmapp.desktop\pmapp-dev.sqlite`),
not in the repository folder, so updating or re-cloning keeps them. Use
**Export project** for backups or to move projects to another computer.
