/**
 * Review drafts live in localStorage so a half-written note survives reloads,
 * tab switches, and a plan being reopened later. One draft per plan version:
 * comments are pinned to a version, and so is the note that accompanies them.
 * Storage can be missing or throw (private mode, quota); every access reports
 * that instead of failing, so review state never depends on persistence.
 */

export interface ReviewDraft {
  note: string;
  pendingComment: { quote: string; body: string; prefix?: string; suffix?: string; position?: number } | null;
}

export const EMPTY_DRAFT: ReviewDraft = { note: "", pendingComment: null };

const PREFIX = "bb-plugin-erwin-plans:draft:";

export function draftKey(planId: string, versionId: string): string {
  return `${PREFIX}${planId}:${versionId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isDraftEmpty(draft: ReviewDraft): boolean {
  return draft.note.trim() === "" && draft.pendingComment === null;
}

function parseDraft(raw: string): ReviewDraft {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return EMPTY_DRAFT;
  const record = parsed as Record<string, unknown>;
  const note = typeof record.note === "string" ? record.note : "";
  const pending = record.pendingComment as Record<string, unknown> | null | undefined;
  const pendingComment =
    typeof pending === "object" &&
    pending !== null &&
    typeof pending.quote === "string" &&
    typeof pending.body === "string"
      ? {
          quote: pending.quote,
          body: pending.body,
          ...(typeof pending.prefix === "string" ? { prefix: pending.prefix } : {}),
          ...(typeof pending.suffix === "string" ? { suffix: pending.suffix } : {}),
          ...(typeof pending.position === "number" ? { position: pending.position } : {}),
        }
      : null;
  return { note, pendingComment };
}

export function readDraft(planId: string, versionId: string): ReviewDraft {
  try {
    const raw = storage()?.getItem(draftKey(planId, versionId));
    return raw ? parseDraft(raw) : EMPTY_DRAFT;
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
