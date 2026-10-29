// The sync services a collaboration build can point at. One place to change
// a URL; every run/build script resolves a target name through here.
// Local-only builds omit network synchronization; local file exchange remains available.
export const COLLAB_TARGETS = Object.freeze({
  staging: process.env.VANTAGE_SYNC_STAGING_ORIGIN,
  production: process.env.VANTAGE_SYNC_PRODUCTION_ORIGIN,
});

/** Set the build-time collaboration variables for `name` on process.env. */
export function applyCollabTarget(name, label) {
  const origin = COLLAB_TARGETS[name];
  if (!origin) {
    console.error(`[${label}] unknown collaboration target "${name}"; use one of: ${Object.keys(COLLAB_TARGETS).join(', ')}`);
    process.exit(64);
  }
  process.env.PMAPP_COLLABORATION = '1';
  process.env.PMAPP_COLLABORATION_ORIGIN = origin;
  console.log(`[${label}] collaboration target: ${name} -> ${origin}`);
  return origin;
}
