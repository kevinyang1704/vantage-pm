# Vantage portable for Windows x64

Extract the entire ZIP to a folder, then double-click start_vantage.bat.
Keep the command window open while using Vantage. Close it to stop the server.
If the browser does not open automatically, open http://127.0.0.1:5173.

No npm install, Rust, administrator access, or internet connection is needed
to launch the extracted package. It includes a portable Node.js executable;
your organization's policy must allow that executable to run. A batch launcher
does not remove executable restrictions. This is a browser app, not Tauri.

Projects are saved in your browser profile on this computer, not in this ZIP
or beside the launcher. Always use the same browser and profile at the exact
address above. Private browsing, a different profile, or clearing site data
can make projects unavailable. Browser storage can also be removed by company
policies. Export important projects regularly.

To collaborate, export a project file and send it using your approved file
sharing channel. Recipients can import it standalone or review and approve
changes to merge into an existing project. The ZIP includes no user projects.
Existing Tauri desktop data does not automatically appear in the browser;
export it from the desktop app, then import it here.

If port 5173 is in use, close the other local server and restart this launcher.
Do not change the address or port to work around this: browser data belongs
to the original address. Replacing the extracted app folder does not migrate
or erase browser storage; export a backup before updating.

For maintainers: run npm run package:portable using Windows x64 Node 24.18.0
after installing development dependencies. The generated ZIP is in release/.
Share the ZIP, not node_modules, your source checkout, or your browser profile.

Maintainer verification: npm run test:portable runs six Chrome scenarios
against the packaged runtime and server, covering export, standalone import,
merge approval, conflict handling, repeat imports, and recovery. Close any
other server on port 5173 before running this check.

From a source checkout, run npm run package:portable once, then double-click
start_vantage.bat in the repository root. It launches the generated build in
release/vantage-pm-portable without installing dependencies or rebuilding.
Run the packaging command again after source changes to update that build.
