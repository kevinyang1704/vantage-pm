// `node scripts/build-web.mjs <staging|production>` — the hosted web app
// built against one sync service (Cloudflare Pages build command). Plain
// `npm run build` stays the local-only web build.
import { spawnSync } from 'node:child_process';
import { applyCollabTarget } from './collab-targets.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/build-web.mjs <staging|production>');
  process.exit(64);
}
applyCollabTarget(target, 'web');
const result = spawnSync('npx', ['vite', 'build', '--mode', 'production'], { stdio: 'inherit', shell: true, env: process.env });
process.exit(result.status ?? 1);
