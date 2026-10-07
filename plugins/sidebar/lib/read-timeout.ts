import type { ReadTimeoutReport } from "./project-mode-contract";

/**
 * A tree read that has not answered by then counts as missed, so an RPC that
 * never settles cannot hold every later refresh until a reload; the next read
 * starts at once and a late answer is ignored.
 */
export const READ_TIMEOUT_MS = 30_000;
export const READ_TIMEOUT_MESSAGE =
  "Couldn't refresh Initiatives (connection slow). Retrying.";
/** A client reports at most one timeout per interval. */
export const REPORT_INTERVAL_MS = 60_000;

export class ReadTimeoutError extends Error {
  constructor(message: string, readonly report: ReadTimeoutReport) {
    super(message);
    this.name = "ReadTimeoutError";
  }
}

// Visibility history for the reports: a timeout right after the tab or the
// device woke up reads differently from one in a visible tab.
const isHidden = () =>
  typeof document !== "undefined" && document.visibilityState === "hidden";
let lastVisibleAt = Date.now();
let lastHiddenAt = isHidden() ? Date.now() : -Infinity;
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    const now = Date.now();
    // Hiding ends a visible stretch; showing starts one.
    lastVisibleAt = now;
    if (isHidden()) lastHiddenAt = now;
  });

const snapshot = (startedAt: number): ReadTimeoutReport => {
  const now = Date.now();
  const hidden = isHidden();
  return {
    elapsedMs: Math.max(0, Math.round(now - startedAt)),
    hidden,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    sinceVisibleMs: hidden ? Math.max(0, Math.round(now - lastVisibleAt)) : 0,
    hiddenDuringRead: hidden || lastHiddenAt >= startedAt,
  };
};

export function withReadTimeout<T>(
  read: Promise<T>,
  ms = READ_TIMEOUT_MS,
  message = READ_TIMEOUT_MESSAGE,
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ReadTimeoutError(message, snapshot(startedAt))),
      ms,
    );
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

let lastReportAt = -Infinity;
/** True at most once per REPORT_INTERVAL_MS for this client. */
export function claimReport(now = Date.now()): boolean {
  if (now - lastReportAt < REPORT_INTERVAL_MS) return false;
  lastReportAt = now;
  return true;
}
/** Tests only: forget the last report. */
export function resetReports(): void {
  lastReportAt = -Infinity;
}
