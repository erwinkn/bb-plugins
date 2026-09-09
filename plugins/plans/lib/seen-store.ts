const key = (planId: string) => `bb-plugin-plans:seen:${planId}`;

export function readLastSeen(planId: string): string | null {
  try { return window.localStorage.getItem(key(planId)); } catch { return null; }
}

export function writeLastSeen(planId: string, versionId: string): void {
  try { window.localStorage.setItem(key(planId), versionId); } catch { /* Storage is optional. */ }
}

export function readShownNotice(planId: string): string | null {
  try { return window.localStorage.getItem(`bb-plugin-plans:notice:${planId}`); } catch { return null; }
}

export function writeShownNotice(planId: string, notice: string): void {
  try { window.localStorage.setItem(`bb-plugin-plans:notice:${planId}`, notice); } catch { /* Storage is optional. */ }
}
