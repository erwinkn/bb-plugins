import type { z } from "zod";

// The one readable form of a settings validation error, shared by Settings, the CLI, RPC and the
// stored-record warnings: "path: message; …", never zod's JSON issue list. root names an issue
// with an empty path (the record itself); without it, such an issue is its message alone.
export function describeIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  root: string | null = null,
): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join(".") || root;
      return path === null ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

// Parses or throws an Error whose message is describeIssues' text.
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(describeIssues(parsed.error.issues));
}
