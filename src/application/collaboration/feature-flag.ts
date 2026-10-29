/**
 * Collaboration feature flag (Story 27.1, AD-20).
 *
 * All sync, identity and sharing code is behind this build-time flag. It is OFF
 * in production builds until 27.10 certifies the epic. With the flag off:
 * - no collaboration module is composed into the app root;
 * - the CSP `connect-src` stays at the 26.8 baseline;
 * - a local project makes zero collaboration network requests.
 *
 * A pre-release build enables it via `--mode <x>-collaboration` or
 * `PMAPP_COLLABORATION=1` (see `vite.config.ts`).
 */

declare const __PMAPP_COLLABORATION__: boolean | undefined;
declare const __PMAPP_COLLABORATION_ORIGIN__: string | undefined;

/** True only when the build enabled collaboration. */
export function isCollaborationEnabled(): boolean {
  return typeof __PMAPP_COLLABORATION__ === 'boolean' && __PMAPP_COLLABORATION__ === true;
}

/**
 * The one configured collaboration service origin, or null when collaboration
 * is off or no origin was configured at build time (item 10). The CSP admits
 * exactly this origin (https + wss) and nothing else.
 */
export function collaborationServiceOrigin(): string | null {
  if (!isCollaborationEnabled()) return null;
  const origin = typeof __PMAPP_COLLABORATION_ORIGIN__ === 'string' ? __PMAPP_COLLABORATION_ORIGIN__ : '';
  return origin.length > 0 ? origin : null;
}
