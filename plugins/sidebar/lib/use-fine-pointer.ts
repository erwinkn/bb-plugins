import { useEffect, useState } from "react";

/** Mouse or trackpad; touch and pen viewports report false. */
export const FINE_POINTER_QUERY = "(pointer: fine)";

// jsdom has no matchMedia; treat that as a touch viewport so hover-only
// controls stay hidden unless a test opts in.
const query = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(FINE_POINTER_QUERY)
    : null;

export function useFinePointer(): boolean {
  const [fine, setFine] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const media = query();
    if (!media) return;
    const update = () => setFine(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return fine;
}
