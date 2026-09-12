import { useEffect, useState } from "react";

// BB's compact breakpoint; slot props carry it for the sidebar, a nav panel
// reads it from the viewport.
export const COMPACT_QUERY = "(max-width: 767px)";

// jsdom has no matchMedia; treat that as a wide viewport.
const query = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COMPACT_QUERY)
    : null;

export function useCompact(): boolean {
  const [compact, setCompact] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}
