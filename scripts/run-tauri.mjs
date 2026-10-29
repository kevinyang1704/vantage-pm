import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Ensures cargo/rustc are on PATH regardless of when the terminal session
// was started (rustup installs to ~\.cargo\bin but existing sessions keep
// the stale PATH). This makes `npm run tauri:*` scripts robust.

const cargoDir = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoDir)) {
  const pathVar = process.env.PATH ?? '';
  if (!pathVar.split(';').some((entry) => entry.toLowerCase() === cargoDir.toLowerCase())) {
    process.env.PATH = `${cargoDir};${pathVar}`;
  }
}

const args = process.argv.slice(2);

// `--collab=<staging|production>` builds/runs the collaboration app against
// that sync service (`--collab` alone means staging). Without it the app is
// local-only, exactly as before. All modes share the same app data; a shared
// project can only be edited from a collaboration build.
const collabIndex = args.findIndex((a) => a === '--collab' || a.startsWith('--collab='));
let collabTarget = null;
if (collabIndex !== -1) {
  const [, target = 'staging'] = args[collabIndex].split('=');
  collabTarget = target;
  args.splice(collabIndex, 1);
  const { applyCollabTarget } = await import('./collab-targets.mjs');
  applyCollabTarget(target, 'tauri');
}

// Story 27.9 item 10: a collaboration desktop build admits exactly the
// configured service origin (https + wss) in the webview CSP, using the same
// pure rule as the browser build. Flag-off builds keep tauri.conf.json as is.
if (process.env.PMAPP_COLLABORATION === '1' && process.env.PMAPP_COLLABORATION_ORIGIN && ['dev', 'build'].includes(args[0])) {
  const { parseCollaborationOrigin, withCollaborationConnectSrc } = await import('../src/app/collaboration-csp.ts');
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const csp = withCollaborationConnectSrc(config.app.security.csp, parseCollaborationOrigin(process.env.PMAPP_COLLABORATION_ORIGIN));
  const override = { app: { security: { csp } } };
  // A staging installer is its own app ("Vantage Staging", own identifier),
  // so it installs beside the production app with separate local data: a
  // project shared on staging never appears in the production app.
  if (args[0] === 'build' && collabTarget === 'staging') {
    override.identifier = `${config.identifier}.staging`;
    override.productName = `${config.productName} Staging`;
    override.app.windows = config.app.windows.map((w) => ({ ...w, title: `${w.title} Staging` }));
  }
  args.push('--config', JSON.stringify(JSON.stringify(override)));
}
const result = spawnSync('npx', ['tauri', ...args], { stdio: 'inherit', shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
