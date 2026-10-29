import { spawnSync } from 'node:child_process';

const mode = process.env.PMAPP_TAURI_MODE ?? 'tauri';
const result = spawnSync('npx', ['vite', 'build', '--mode', mode], { stdio: 'inherit', shell: true });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
