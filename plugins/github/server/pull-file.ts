import { z } from "zod";
import { PULL_PAGE_SIZE } from "../contract";

const refSchema = z.string().min(1);
const refsSchema = z.object({ base: refSchema, head: refSchema }).strict();
const mergeBaseSchema = z.object({ mergeBase: refSchema }).strict();
const filesSchema = z.object({ files: z.array(z.object({
  path: z.string().min(1), patch: z.string().nullable().transform((patch) => patch !== null && patch.length > 20_000 ? null : patch),
}).strict()).max(PULL_PAGE_SIZE) }).strict();
const refreshMessage = "Pull request changed since it was opened. Refresh the pull request before loading this diff.";

// Structured output is essential: gh prints scalar jq strings as raw text and
// scalar null as a blank line. Keep at most 20 bounded patches, only in flight.
const patchProjection = '{files:[.[] | {path:.filename,patch:(if has("patch") then (if (.patch|type) == "string" and (.patch|length) > 20000 then null else .patch end) else null end)}]}';
type Input = { repo: string; number: number; page: number; oldRef: string; newRef: string };
type Snapshot = { mergeBase: string; files: z.infer<typeof filesSchema>["files"] };

/** Share concurrent expansions only; every later expansion revalidates the PR. */
export function createPullFileSnapshots(gh: (args: string[], timeoutMs?: number) => Promise<string>) {
  const inFlight = new Map<string, Promise<Snapshot>>();
  async function mergeBase(repo: string, base: string, head: string) {
    const comparison = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const raw = await gh(["api", `repos/${repo}/compare/${comparison}?per_page=1&page=1`, "--jq", "{mergeBase:.merge_base_commit.sha}"], 30_000);
    return mergeBaseSchema.parse(JSON.parse(raw)).mergeBase;
  }
  async function fetch({ repo, number, page, oldRef, newRef }: Input): Promise<Snapshot> {
    // PRs show a three-dot diff: the old contents must come from the merge base,
    // not the current base branch tip. Compare immutable SHAs, without history.
    const [originalBase, raw] = await Promise.all([
      mergeBase(repo, oldRef, newRef),
      gh(["api", `repos/${repo}/pulls/${number}/files?per_page=${PULL_PAGE_SIZE}&page=${page}`, "--jq", patchProjection], 30_000),
    ]);
    const { files } = filesSchema.parse(JSON.parse(raw));
    if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("GitHub returned duplicate file paths.");
    // Check after reading patches. A base-tip advance is harmless only if the
    // merge base stays the same. A fixed head can still acquire a new diff base.
    const refs = refsSchema.parse(JSON.parse(await gh(["api", `repos/${repo}/pulls/${number}`, "--jq", "{base:.base.sha,head:.head.sha}"], 30_000)));
    if (refs.head !== newRef) throw new Error(refreshMessage);
    const currentBase = refs.base === oldRef ? originalBase : await mergeBase(repo, refs.base, newRef);
    if (currentBase !== originalBase) throw new Error(refreshMessage);
    return { mergeBase: originalBase, files };
  }
  return (input: Input): Promise<Snapshot> => {
    const key = JSON.stringify([input.repo, input.number, input.page, input.oldRef, input.newRef]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = fetch(input).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  };
}
