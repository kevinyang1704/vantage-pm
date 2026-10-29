# Run Vantage on your computer (Docker)

Vantage runs in your web browser. Docker builds it and serves it on your own
computer, so you don't need Node, Rust or anything else installed. This copy is
**local-only**: no account or hosted service is required. Projects stay on your computer.
To collaborate, exchange files manually using [Share for editing and reviewed merges](local-collaboration.md).

## First time

1. Install **Docker Desktop** and start it.
2. Get the code from the **`main`** branch (you need access to the repository):
   ```
   git clone <your-vantage-pm-repository-url>
   cd vantage-pm
   ```
   Or on GitHub switch to the `main` branch, then **Code → Download ZIP**.
3. Build and start it (the first build takes a few minutes):
   ```
   docker compose up -d --build
   ```
4. Open **http://localhost:8080** in Chrome or Edge.

## Every day

- Docker Desktop restarts Vantage automatically. Just open
  **http://localhost:8080**.
- Stop it: `docker compose down` (your projects are not affected).

## Update to a newer version

```
git pull
docker compose up -d --build
```
Reload the page. Your projects stay.

## Where your projects live — read this

Your projects are stored **in your browser**, for the address
`http://localhost:8080`, not in Docker and not on any server.

- Use the **same browser** and the **same address** (keep port 8080). A
  different browser, profile or port starts with an empty workspace.
- **Clearing your browser's site data for localhost deletes your projects.**
  So does a work policy that wipes browser profiles.
- Back up regularly: **Export project** saves a file you can import again
  later or on another computer.

## If something goes wrong

| Problem | Fix |
|---|---|
| `port is already allocated` | Something else uses 8080. Stop it, or change the left number in `compose.yaml` (`"127.0.0.1:8081:8080"`) and use that address from now on (it starts empty; import your exports). |
| Container is running but http://localhost:8080 doesn't load | After a port clash, Docker can keep a container without its port. Run `docker compose up -d --force-recreate`. |
| The build can't download (`node`, `nginx`, npm packages) | Your network blocks Docker Hub or the npm registry. Ask IT for the company registry mirror or proxy settings for Docker Desktop. |
| Blank page | Use a current Chrome or Edge; reload with Ctrl+Shift+R. |
| "Storage unavailable" | Don't use a private/incognito window; it can't keep data. |

Maintainers: the image is `docker/web/Dockerfile` (Node 24.18 build with the
locked dependencies, served by nginx with the cross-origin-isolation headers
the in-browser database needs). It is separate from the root `Dockerfile`,
which is for the optional network service and is not used to run the local app.
