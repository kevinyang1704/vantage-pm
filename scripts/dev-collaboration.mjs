// Network collaboration dogfooding (Epic 27). Two modes:
//   node scripts/dev-collaboration.mjs server  -> pmapp-server on 127.0.0.1:8787
//   node scripts/dev-collaboration.mjs app     -> collaboration-flag Vite dev on 127.0.0.1:5292
// The server uses a throwaway data dir under .collab-dev/ (git-ignored by the
// leading dot rule below) and allows exactly the dev app origin. No backups,
// no credentials, no remote service.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP_PORT = process.env.PMAPP_COLLAB_APP_PORT ?? '5292';
const SERVER_PORT = process.env.PMAPP_COLLAB_SERVER_PORT ?? '8787';
const mode = process.argv[2];

if (mode === 'server') {
  const dataDir = process.env.PMAPP_DATA_DIR ?? '.collab-dev/data';
  mkdirSync(dataDir, { recursive: true });
  spawn('cargo', ['run', '-p', 'pmapp-server'], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? 'target/collab-dev', PMAPP_DATA_DIR: dataDir, PMAPP_SERVER_ADDR: `127.0.0.1:${SERVER_PORT}`, PMAPP_ALLOWED_ORIGINS: `http://127.0.0.1:${APP_PORT},http://localhost:${APP_PORT}` },
  }).on('exit', (code) => process.exit(code ?? 1));
} else if (mode === 'app') {
  spawn('npx', ['vite', '--mode', 'qualification', '--port', APP_PORT], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, PMAPP_COLLABORATION: '1', PMAPP_COLLABORATION_ORIGIN: `http://127.0.0.1:${SERVER_PORT}` },
  }).on('exit', (code) => process.exit(code ?? 1));
} else {
  console.error('usage: node scripts/dev-collaboration.mjs server|app');
  process.exit(64);
}
