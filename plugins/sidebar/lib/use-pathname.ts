import { useSyncExternalStore } from "react";

// BB gives sidebar plugins the active thread and project, not the route, so a
// panel entry reads the page path itself. The Navigation API reports every
// client-side route change; popstate covers browsers without it.
const navigation = () => (globalThis as { navigation?: EventTarget }).navigation;

function subscribe(onChange: () => void) {
  navigation()?.addEventListener("currententrychange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    navigation()?.removeEventListener("currententrychange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}

/** The current page path, kept in sync with client-side navigation. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname, () => "");
}
