/**
 * Story 28.2: `vantage://join?…` / `vantage://recover?…` links handed to the
 * desktop app by the OS. The native side accepts only well-formed links; the
 * link that started the app is taken once, later ones arrive as an event.
 * Native builds only — the composition root gates on `isNativeBridge()`.
 */

export async function subscribeVantageLinks(onLink: (link: string) => void): Promise<() => void> {
  const [{ invoke }, { listen }] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/api/event'),
  ]);
  const unlisten = await listen<{ link: string }>('vantage-link', (event) => {
    if (typeof event.payload?.link === 'string') onLink(event.payload.link);
  });
  const pending = await invoke<string | null>('app_take_pending_link');
  if (pending) onLink(pending);
  return unlisten;
}
