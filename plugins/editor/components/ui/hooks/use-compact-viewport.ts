import { useSyncExternalStore } from "react";

/** Below this the menus of the scope bar open as a bottom drawer, as in BB. */
const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";

let compact: MediaQueryList | null = null;

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  compact ??= window.matchMedia(COMPACT_VIEWPORT_QUERY);
  return compact;
}

export function useIsCompactViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = query();
      list?.addEventListener("change", notify);
      return () => list?.removeEventListener("change", notify);
    },
    () => query()?.matches ?? false,
    () => false,
  );
}
