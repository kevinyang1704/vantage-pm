# Vantage PM

A local-first product planning app. Maintain one vision tree and work with it through an outline, visual tree, Gantt chart, capacity forecasts, and Word or PowerPoint exports.

This public repository contains the app, its local runtimes, tests, and documentation. The marketing website and landing-page code are maintained separately and are excluded here.

## Run locally

Use Node.js **24.18.0** and npm **11.16.0**. No account or hosted service is required.

```sh
npm ci --ignore-scripts
npm start
```

Open **http://127.0.0.1:5173** in Chrome or Edge. On Windows, you can also double-click `start-web.bat`. Initial dependency installation needs access to npm or your workplace's package mirror; using the local app does not require deploying anything.

Projects stay in that browser's local SQLite storage. Use the same browser and address each time, and export backups before clearing site data.

## Collaborate without a server

1. Choose **Share for editing** and send the `.vantage-share.json` file through your workplace's approved channel.
2. Your teammate imports it as a standalone project with **Keep linked for future file exchanges** enabled, makes edits, and shares their version back.
3. Import their file and choose **Merge into existing project**. Review additions, edits, moves, deletions, and conflicts before approving.

You can also import an independent project as a new branch, or create a separate standalone copy. **Use incoming**, **Keep mine**, and **Decide later** control what is applied. Repeated imports do not duplicate accepted changes, and **Recover previous merge** restores a saved recovery point, including after a restart.

Files contain the whole shared project and its recorded checkpoints. Nothing synchronizes automatically. See the [local collaboration guide](docs/local-collaboration.md) for conflict handling, recovery, and the 30 MB / 32-checkpoint limits.

## Choose how to run

| Option | Guide |
|---|---|
| Browser on your computer | [Run in a browser](docs/run-in-browser.md) |
| Windows desktop from source | [Run the desktop app](docs/run-desktop-from-source.md) |
| Local browser app in Docker | [Run locally with Docker](docs/run-locally-with-docker.md) |
| Features and controls | [User guide](docs/USER-GUIDE.md) |

The Windows desktop app uses local Rust SQLite storage and requires the Tauri build prerequisites. After installing them, run `npm run tauri:dev`. Browser and desktop exchange the same portable project and collaboration files.

## Development

```sh
npm run dev
npm run check:app-only
npm run typecheck
npm run test:unit
npm run build
cargo test -p pmapp-core --lib
```

Source: `src/domain` contains rules, `src/application` use cases, `src/adapters` UI and persistence, `src/contracts` file and command formats, `src-tauri` the desktop shell, and `crates/pmapp-core` the shared Rust runtime. `spikes/phase-0-durability` contains persistence infrastructure still used by the app and tests. Default app builds use local storage and file exchange; network collaboration is disabled.

`check:app-only` runs in CI and rejects marketing/landing-page files. App icons and the in-app Vantage mark are part of the app and remain included. Internal planning, agent tooling, personal project exports, and generated test evidence are excluded from the public distribution.

## Status and backups

Active development; this source is not a certified release. Keep backups of important projects. **Export project** writes a portable `.pmapp.json` file; **Import** can create a separate project or review a merge. Use **Share for editing** when you want to retain the history needed for continued collaboration. Internal storage identifiers retain the original `pmapp` name for compatibility.

## License

[MIT](LICENSE). Original copyright attribution is retained.
