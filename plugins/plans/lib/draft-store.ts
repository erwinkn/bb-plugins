export interface ReviewDraft {
  pendingComment: { quote: string; body: string; kind?: "comment" | "ask"; versionId?: string; prefix?: string; suffix?: string; position?: number } | null;
}

export const EMPTY_DRAFT: ReviewDraft = { pendingComment: null };

const PREFIX = "bb-plugin-plans:draft:";

export function draftKey(planId: string, _versionId?: string): string {
  return `${PREFIX}${planId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isDraftEmpty(draft: ReviewDraft): boolean {
  return draft.pendingComment === null;
}

function parseDraft(raw: string): ReviewDraft {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return EMPTY_DRAFT;
  const record = parsed as Record<string, unknown>;
  const pending = record.pendingComment as Record<string, unknown> | null | undefined;
  const pendingComment =
    typeof pending === "object" &&
    pending !== null &&
    typeof pending.quote === "string" &&
    typeof pending.body === "string"
      ? {
          quote: pending.quote,
          ...(typeof pending.versionId === "string" ? { versionId: pending.versionId } : {}),
          body: pending.body,
          kind: pending.kind === "ask" ? "ask" as const : "comment" as const,
          ...(typeof pending.prefix === "string" ? { prefix: pending.prefix } : {}),
          ...(typeof pending.suffix === "string" ? { suffix: pending.suffix } : {}),
          ...(typeof pending.position === "number" ? { position: pending.position } : {}),
        }
      : null;
  return { pendingComment };
}

export function readDraft(planId: string, versionId: string): ReviewDraft {
  try {
    const store = storage();
    const raw = store?.getItem(draftKey(planId));
    if (raw) return parseDraft(raw);
    // Recover drafts saved by the former per-version format, including a
    // draft on an older version when the review reopens on the latest one.
    const legacyPrefix = `${PREFIX}${planId}:`;
    const keys = store ? Array.from({ length: store.length }, (_, index) => store.key(index)!) : [];
    const legacyKeys = keys.filter((key) => key.startsWith(legacyPrefix));
    legacyKeys.sort((a, b) => Number(b === `${legacyPrefix}${versionId}`) - Number(a === `${legacyPrefix}${versionId}`));
    for (const key of legacyKeys) {
      const draft = parseDraft(store!.getItem(key)!);
      if (!draft.pendingComment) continue;
      draft.pendingComment.versionId ??= key.slice(legacyPrefix.length);
      if (writeDraft(planId, versionId, draft)) legacyKeys.forEach((old) => store!.removeItem(old));
      return draft;
    }
    return EMPTY_DRAFT;
  } catch {
    return EMPTY_DRAFT;
  }
}

/** Returns false when the draft could not be persisted. */
export function writeDraft(planId: string, versionId: string, draft: ReviewDraft): boolean {
  const store = storage();
  if (store === null) return false;
  const key = draftKey(planId, versionId);
  try {
    if (isDraftEmpty(draft)) store.removeItem(key);
    else store.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(planId: string, versionId: string): void {
  try {
    storage()?.removeItem(draftKey(planId, versionId));
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
