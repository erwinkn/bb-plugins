/** Turns an RPC or runtime failure into copy the UI can show. */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const issues = (cause as { issues?: unknown }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const detail = issues
        .map((issue) => {
          if (typeof issue !== "object" || issue === null) return null;
          const record = issue as { message?: unknown; path?: unknown };
          const path = Array.isArray(record.path) ? record.path.join(".") : "";
          const message = typeof record.message === "string" ? record.message : "";
          return path ? `${path}: ${message}` : message;
        })
        .filter((line): line is string => typeof line === "string" && line !== "")
        .join("; ");
      if (detail !== "") return detail;
    }
    return cause.message || "Something went wrong.";
  }
  return typeof cause === "string" && cause !== "" ? cause : "Something went wrong.";
}
