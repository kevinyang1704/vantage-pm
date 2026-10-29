# PMApp Browser Test Framework

This Playwright scaffold supports Gate A engineering qualification and later Gate B release certification. It is test infrastructure only: the sample proves the framework works, not that PMApp persistence is qualified, durable, or certified.

## Setup

1. Use Node `24.18.0` from `.nvmrc` or the checksum-verified workspace runtime under `.tools/`.
2. Install dependencies without third-party lifecycle scripts:

   ```powershell
   .\.tools\node-v24.18.0-win-x64\npm.cmd install --ignore-scripts
   ```

3. Chrome and Edge must be installed for the branded-browser projects in `playwright.config.ts`.

No managed application server is configured yet. Story 1.1 owns the Gate A spike host lifecycle and must serve COOP/COEP headers for the test-only shared-memory fault barrier.

## Running tests

```powershell
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:debug
npm run test:e2e:list
npm run test:acceptance
npm run test:acceptance:list
```

Two servers, two overrides. `BASE_URL` is the product app (default `http://127.0.0.1:5173`); set it to run from a git worktree whose dev server is on another port, e.g. `BASE_URL=http://127.0.0.1:5175`. `QUALIFICATION_URL` is the Phase 0 durability harness (default `http://127.0.0.1:4173`). Every product spec must read `process.env.BASE_URL ?? 'http://127.0.0.1:5173'` — a hardcoded port runs against whatever holds 5173 (for example a `vite --mode tauri` server, where browser storage cannot be read). `TEST_ENV` describes the logical target. `API_URL` is intentionally blank because v1 has no remote backend.

Story-level ATDD scaffolds live under `tests/acceptance/` and `tests/e2e/phase-0-durability/`. They remain skipped until the developer activates the scenario for the current implementation task and first confirms the expected RED failure.

## Architecture

```text
tests/
  e2e/                         # Browser scenarios
  support/
    factories/                 # Deterministic data builders with explicit overrides
    fixtures/                  # Merged Playwright fixtures and automatic teardown
    helpers/                   # Narrow, stateless browser helpers when needed
```

- Import `test` and `expect` from `tests/support/fixtures`, never directly from Playwright in scenarios.
- `projectFactory` is independently seeded for each test to remain repeatable and parallel-safe.
- `cleanup.add()` registers teardown in reverse creation order and reports every cleanup failure.
- The automatic network monitor fails otherwise-green tests on unexpected HTTP 4xx/5xx responses and attaches a redacted JSON report.
- `playwright.config.ts` runs the same scenarios against branded Chrome and Edge and retains failure artifacts.

## Test practices

- Structure scenarios as Given / When / Then and assert observable outcomes.
- Prefer accessible roles and labels; use stable `data-testid` values when semantic selectors are insufficient.
- Register routes and response listeners before the action that triggers traffic. Never use fixed sleeps.
- Keep every test isolated. Use factories for input and register cleanup at resource creation time.
- Do not place authored body text in traces, logs, or retained evidence unless the fixture is explicitly synthetic.
- Treat unexpected outbound traffic as a failure. PMApp may fetch versioned same-origin static assets only; authored content and diagnostics never leave the origin.
- Use unique browser profiles, origins, and OPFS namespaces for destructive durability runs.
- A green sample or isolated story run is not Gate A PASS or Gate B certification. Both remain governed by `PHASE-0-DURABILITY.md`.

## CI integration

- Run `npm run test:e2e` for the Chrome/Edge matrix.
- The configuration forbids focused tests in CI, retries failures twice for artifact collection, and uses one worker per CI job until destructive-state sharding is explicitly designed.
- Publish `playwright-report/` and `test-results/` only as test artifacts; both are ignored locally.
- Gate A/Gate B CI and lab runs retain immutable manifests, subject/asset/lock/build hashes, crash logs, receipt/revision checks, `quick_check`, and append-only PASS/FAIL history under `reports/evidence/`.

## Troubleshooting

- If a branded project cannot launch, install or update Chrome/Edge and rerun `npm run test:e2e:list`.
- If configuration fails to load, verify Node `24.18.0` and run the exact workspace npm install command above.
- If a test waits indefinitely, confirm routes and response listeners are registered before the triggering action.
- Open `playwright-report/index.html` after a failure; retained traces, screenshots, and video are configured automatically.

## Knowledge references

