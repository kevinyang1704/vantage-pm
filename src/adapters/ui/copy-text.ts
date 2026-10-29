/**
 * Put text on the clipboard and report whether it actually happened, so the UI
 * never claims "copied" when it was not. The async Clipboard API can be refused
 * (permission policy, embedded webviews, an unfocused document); the fallback
 * copies a selected off-screen textarea through the legacy copy command.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: try the selection fallback below.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
