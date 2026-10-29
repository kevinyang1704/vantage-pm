import { spawnSync } from 'node:child_process';

const env = { ...process.env, PMAPP_TAURI_MODE: 'tauri-qualification' };
const result = spawnSync('npx', ['tauri', 'build', '--features', 'qualification', '--', '--features', 'qualification'], {
  stdio: 'inherit',
  shell: true,
  env,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
