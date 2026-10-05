import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PullPage, PullSection } from "../contract";
import { errorText, type Contract, type PullDetail, type ReviewThread } from "./shared";

type ReviewComment = Extract<PullPage, { section: "reviewComments" }>["items"][number];
export type PageState = { loaded: boolean; loading: boolean; nextPage: number | null; error: string | null; limitation: string | null };
const emptyPage = (): PageState => ({ loaded: false, loading: false, nextPage: 1, error: null, limitation: null });
const emptyPages = (): Record<PullSection, PageState> => ({ comments: emptyPage(), reviews: emptyPage(), reviewComments: emptyPage(), files: emptyPage(), commits: emptyPage() });

export function mergePullItems<T>(current: T[], incoming: T[], key: (item: T) => string): T[] {
  const merged = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) merged.set(key(item), item);
  return [...merged.values()];
}

/** Regroup after each page so replies never become separate permanent threads. */
export function groupReviewComments(comments: ReviewComment[]): { threads: ReviewThread[]; missingParents: boolean } {
  const byId = new Map(comments.map((item) => [item.id, item]));
  const grouped = new Map<string, ReviewThread>();
  let missingParents = false;
  for (const comment of comments) {
    let root = comment;
    const seen = new Set([root.id]);
    while (root.inReplyToId !== null && byId.has(root.inReplyToId) && !seen.has(root.inReplyToId)) {
      root = byId.get(root.inReplyToId)!;
      seen.add(root.id);
    }
    if (root.inReplyToId !== null) missingParents = true;
    const key = root.inReplyToId ?? root.id;
    let thread = grouped.get(key);
    if (!thread) {
      thread = { path: root.path, line: root.line, diffHunk: root.diffHunk, comments: [] };
      grouped.set(key, thread);
    }
    thread.comments.push(comment);
  }
  for (const thread of grouped.values()) thread.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { threads: [...grouped.values()], missingParents };
}

export function usePullDetail(repo: string, number: number, scope = "") {
  const rpc = useRpc<Contract>();
  const identity = `${scope}:${repo}#${number}`;
  const generation = useRef(0);
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const busy = useRef(new Set<PullSection>());
  const reviewComments = useRef<ReviewComment[]>([]);
  const reviewGroups = useRef({ threads: [] as ReviewThread[], missingParents: false });
  const [state, setState] = useState<{ identity: string; pull: PullDetail | null; error: string | null; pages: Record<PullSection, PageState> }>({ identity, pull: null, error: null, pages: emptyPages() });

  const refresh = useCallback(() => {
    const token = ++generation.current;
    busy.current.clear();
    reviewComments.current = [];
    reviewGroups.current = { threads: [], missingParents: false };
    setState({ identity, pull: null, error: null, pages: emptyPages() });
    rpc.call("getPull", { repo, number }).then(
      ({ pull }) => {
        if (generation.current !== token || activeIdentity.current !== identity) return;
        setState({ identity, pull: { ...pull, comments: [], reviews: [], reviewThreads: [], files: [], commits: [] }, error: null, pages: emptyPages() });
      },
      (error: unknown) => {
        if (generation.current === token && activeIdentity.current === identity) setState((current) => ({ ...current, error: errorText(error) }));
      },
    );
  }, [rpc, repo, number, identity]);
  useEffect(() => {
    refresh();
    return () => { generation.current++; };
  }, [refresh]);

  const loadPage = useCallback((section: PullSection) => {
    const page = state.pages[section].nextPage;
    if (state.identity !== identity || !state.pull || page === null || busy.current.has(section)) return;
    busy.current.add(section);
    const token = generation.current;
    setState((current) => ({ ...current, pages: { ...current.pages, [section]: { ...current.pages[section], loading: true, error: null } } }));
    rpc.call("getPullPage", { repo, number, section, page }).then(
      (result) => {
        if (generation.current !== token || activeIdentity.current !== identity) return;
        if (result.section !== section) throw new Error("GitHub returned a different history section.");
        if (result.nextPage !== null && result.nextPage !== page + 1) throw new Error("GitHub returned an invalid continuation page.");
        // Raw review comments are retained only in this view, not server-global.
        if (result.section === "reviewComments") {
          reviewComments.current = mergePullItems(reviewComments.current, result.items, (item) => item.id);
          reviewGroups.current = groupReviewComments(reviewComments.current);
        }
        const groups = reviewGroups.current;
        setState((current) => {
          if (!current.pull) return current;
          const pull = { ...current.pull };
          switch (result.section) {
            case "comments": pull.comments = mergePullItems(pull.comments, result.items, (item) => item.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
            case "reviews": pull.reviews = mergePullItems(pull.reviews, result.items, (item) => item.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
            case "files": pull.files = mergePullItems(pull.files, result.items, (item) => item.path); break;
            case "commits": pull.commits = mergePullItems(pull.commits, result.items, (item) => item.sha); break;
            case "reviewComments": pull.reviewThreads = groups.threads; break;
          }
          return { ...current, pull, pages: { ...current.pages, [section]: { loaded: true, loading: false, nextPage: result.nextPage, error: null, limitation: result.limitation } } };
        });
      },
    ).catch((error: unknown) => {
      if (generation.current !== token || activeIdentity.current !== identity) return;
      setState((current) => ({ ...current, pages: { ...current.pages, [section]: { ...current.pages[section], loading: false, error: errorText(error) } } }));
    }).finally(() => { if (generation.current === token) busy.current.delete(section); });
  }, [rpc, repo, number, identity, state]);

  return { pull: state.identity === identity ? state.pull : null, error: state.identity === identity ? state.error : null, pages: state.pages, refresh, loadPage, missingReviewParents: reviewGroups.current.missingParents };
}
