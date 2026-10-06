import { createHash } from "node:crypto";
import type { AssignmentRecord } from "./store";

// Write holds were removed in T136 (overlapping writers only get a warning); only the
// report version remains, used by context reads and embedded-report provenance.

/**
 * A short fingerprint of one report filing. The filing count makes an identical re-file a
 * new version even on a frozen clock; the filing time also covers reports stored by a build
 * that did not count.
 */
export const reportVersion = (a: Pick<AssignmentRecord, "report" | "reportSeq" | "reportedAt">) =>
  createHash("sha256").update(JSON.stringify([a.reportSeq, a.reportedAt, a.report ?? null])).digest("hex").slice(0, 16);

