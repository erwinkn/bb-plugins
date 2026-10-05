// The fake reviewer: a deterministic, tools-less test double that makes no
// network request and no judgment. It cites the first changed line pair of the
// first test edit in the packet, at severity "note", so a preview exercises the
// real packet builder, validator, findings store and panel. Its findings say
// they are fake. Nothing it reports is evidence about the watched work.

import { ROUTES } from "../config/routes.js";
import { referenceSerializer } from "../rules/packet.js";
import type { ModelFinding } from "./output.js";
import type { ReviewRequest, ReviewTransport, SendResult } from "./types.js";

export const FAKE_SUMMARY =
  "Fake reviewer preview: this citation went through the real validator. The fake reviewer makes no judgment about the change.";

export function fakeFindings(req: ReviewRequest): ModelFinding[] {
  for (const card of req.cards) {
    if (!card.hunks) continue;
    for (let hi = 0; hi < card.hunks.length; hi++) {
      const h = card.hunks[hi]!;
      const removed = h.lines.find((l) => l.kind === "-");
      const added = h.lines.find((l) => l.kind === "+");
      if (!removed && !added) continue;
      return [
        {
          category: "test-integrity",
          severity: "note",
          evidence: card.id,
          hunk: hi,
          subject: null,
          relation: null,
          before: removed ? { hunk: null, lines: [removed.old!, removed.old!], quote: removed.text } : null,
          after: added ? { hunk: null, lines: [added.new!, added.new!], quote: added.text } : null,
          requirement: null,
          claim: null,
          command: null,
          summary: FAKE_SUMMARY,
        },
      ];
    }
  }
  return [];
}

/** A scripted reviewer (tests): findings only, or findings with resolved notes. */
export type FakeScript = (req: ReviewRequest) => FakeAnswer | Promise<FakeAnswer>;
type FakeAnswer = ModelFinding[] | { findings: ModelFinding[]; resolved: Array<{ locator: string; evidence: string; note: string }> };

export function fakeTransport(script: FakeScript = fakeFindings): ReviewTransport {
  return {
    route: ROUTES.fake,
    serialize: referenceSerializer("fake"),
    async send(req: ReviewRequest, signal: AbortSignal): Promise<SendResult> {
      if (signal.aborted) return { outcome: "pre-upstream", status: null, dispatched: "none", error: "canceled before the fake ran" };
      const answer = await script(req);
      return {
        outcome: "completed",
        status: 200,
        dispatched: "none",
        model: null,
        usage: null,
        output: Array.isArray(answer) ? { findings: answer, resolved: [] } : answer,
      };
    },
  };
}
