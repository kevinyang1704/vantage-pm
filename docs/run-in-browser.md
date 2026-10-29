# Run Vantage in your browser (local-only)

Vantage runs in Chrome or Edge from a small server on your own computer. It is
**local-only**: no account or hosted service is required. Projects stay on your computer.
To collaborate, exchange files manually using [Share for editing and reviewed merges](local-collaboration.md).

## What you need

| Need | Notes |
|---|---|
| **Node.js 24** (includes npm) | From your company's software source. |
| **Access to npm packages** | The public npm registry, or your company's npm mirror (see below). Only needed for the first run and after updates. |
| **Chrome or Edge** (current) | Firefox/Safari are not supported. |
| The code (`main` branch) | `git clone <your-vantage-pm-repository-url>`, or on GitHub switch to `main` → **Code → Download ZIP**. |

No Rust, no Visual Studio, no Docker, no admin rights.

## Start

Double-click **`start-web.bat`** in the `vantage-pm` folder. The first time it
downloads the app's packages (a minute or two); then it builds the app and
opens **http://127.0.0.1:5173**. Keep that window open while you use Vantage;
close it to stop.

From a terminal instead:
```
npm ci --ignore-scripts
npm start
```

### Company npm mirror

If the first run fails to download packages, point npm at your company mirror
once (IT can give you the address), then run `start-web.bat` again:
```
npm config set registry https://<your-company-npm-mirror>/
```

## Update

Get the newer code (`git pull`, or a fresh ZIP into the same folder), delete
the `node_modules` folder if `package-lock.json` changed, and start again.
Your projects stay.

## Where your projects live — read this

Your projects are stored **in your browser**, for the address
`http://127.0.0.1:5173` — not in the folder and not on any server.

- Always use the **same browser** and the **same address**
  (`127.0.0.1:5173`; `localhost:5173` counts as a different address and
  starts empty).
- **Clearing the browser's site data deletes your projects**, and so does a
  work policy that wipes browser profiles. Don't use a private window.
- Back up regularly: **Export project** saves a file you can import again.

## If something goes wrong

| Problem | Fix |
|---|---|
| `Port 5173 is already in use` | Another copy (or another dev server) is running. Close it (or its window), then start again. |
| `This needs Node.js 24` | Install Node.js 24 from your company's software source. |
| Packages won't download | Set the company npm mirror (above). |
| Blank page | Current Chrome or Edge; reload with Ctrl+Shift+R. |
