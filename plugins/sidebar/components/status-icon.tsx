import type { Status } from "../lib/status";

const COLOR: Record<Status, string> = {
  attention: "text-[var(--warning-text)]",
  unread: "text-sky-600 dark:text-sky-400",
  working: "text-[var(--success)]",
  draft: "text-violet-600 dark:text-violet-400",
  done: "text-[var(--subtle-foreground)]",
};

export function StatusIcon({
  status,
  className = "",
  size = "default",
}: {
  status: Status;
  className?: string;
  size?: "small" | "default";
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${size === "small" ? "size-3.5" : "size-4"} shrink-0 ${COLOR[status]} ${status === "working" ? "motion-safe:animate-spin" : ""} ${className}`}
    >
      {status === "attention" && (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 6v4m0 3h.01" />
        </>
      )}
      {status === "unread" && (
        <>
          <path d="M4 13.5h12l-1.5-3V7a4.5 4.5 0 0 0-9 0v3.5zM8 16a2.2 2.2 0 0 0 4 0" />
        </>
      )}
      {status === "working" && (
        <path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.34 4.34l1.42 1.42m8.48 8.48 1.42 1.42M4.34 15.66l1.42-1.42m8.48-8.48 1.42-1.42" />
      )}
      {status === "draft" && (
        <circle cx="10" cy="10" r="7.5" strokeDasharray="3 3" />
      )}
      {status === "done" && (
        <>
          <circle cx="10" cy="10" r="7.5" />
          <path d="m6.5 10 2.3 2.3 4.7-4.6" />
        </>
      )}
    </svg>
  );
}
