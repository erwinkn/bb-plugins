import { useState } from "react";

// Durable UI choices, per browser (localStorage, never synced): the dashboard
// tab and the PRs tab's view and filters, so leaving the dashboard (a browser
// tab, another panel tab) and coming back, or reloading, restores them.

function read<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    const value: unknown = raw === null ? undefined : JSON.parse(raw);
    return valid(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A useState whose value survives remounts and reloads under `key`; a stored value `valid` rejects reads as `fallback`. */
export function useRemembered<T>(key: string, fallback: T, valid: (value: unknown) => value is T): [T, (value: T) => void] {
  const [state, setState] = useState(() => ({ key, value: read(key, valid) ?? fallback }));
  const current = state.key === key ? state.value : read(key, valid) ?? fallback;
  const set = (value: T) => {
    setState({ key, value });
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage full or blocked: the choice still holds until the view unmounts.
    }
  };
  return [current, set];
}
