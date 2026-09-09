import { describe, expect, it } from "vitest";
import { planSchema } from "../contract";
import { messageQuote, renderEvent, renderMessage, type ReviewEvent } from "./message";
const plan = planSchema.parse({
  id: "plan-1", title: "Storage migration", threadId: null, projectId: null, projectName: null, status: "open", createdAt: 0, updatedAt: 0,
  versions: [{ id: "v4", number: 4, markdown: "# Storage\n\nMigrate the users table first\nRun the backfill\nin a single transaction\nAdd a feature flag\nKeep the old API\nRepeat\nRepeat", createdAt: 0 }],
});
const event = (number: number, annotationKind: "comment" | "ask" | "redline" | "looksGood", quote: string, body = ""): ReviewEvent => ({ kind: "annotation", annotationId: `a${number}`, number, annotationKind, quote, body, revision: 0 });

describe("compact feedback messages", () => {
  it("renders all four kinds and the exact closing instructions", () => {
    expect(renderMessage(plan, [event(7, "comment", "Migrate the users table first", "Do the sessions table first."), event(8, "ask", "Run the backfill in a single transaction", "Why one transaction?"), event(9, "redline", "Add a feature flag"), event(10, "looksGood", "Keep the old API")])).toBe(`Plan "Storage migration" (plan plan-1, v4) — 4 new items

#7 comment · L3
> Migrate the users table first
Do the sessions table first.

#8 ask · L4–5
> Run the backfill in a single transaction
Why one transaction?

#9 redline · L6
> Add a feature flag

#10 looks good · L7
> Keep the old API`);
  });
  it("omits locations for missing and repeated quotes", () => {
    expect(renderMessage(plan, [event(1, "redline", "Missing"), event(2, "looksGood", "Repeat")])).toBe(`Plan "Storage migration" (plan plan-1, v4) — 2 new items

#1 redline
> Missing

#2 looks good
> Repeat`);
  });
  it("renders replies, withdrawals, approval and mode changes", () => {
    expect(renderMessage(plan, [
      { kind: "reply", annotationId: "a7", replyId: "r1", number: 7, quote: "Migrate the users table first", body: "Include schedules too." },
      { kind: "withdrawn", annotationId: "a8", number: 8 },
      { kind: "deliveryMode", mode: "steer-if-active" },
      { kind: "approved", versionId: "version-6", versionNumber: 6 },
    ])).toBe(`Plan "Storage migration" (plan plan-1, v4) — 4 new items

reply on #7 · L3
> Migrate the users table first
Include schedules too.

withdrawn #8

delivery mode: steer-if-active

approved v6
Implement plan plan-1 version 6.
Run \`bb plans get plan-1 --version-id version-6\` to read the approved version.`);
  });
  it("preserves full normalized quotes in redlines and replies", () => {
    const quote = "a".repeat(300) + " \n complete removal target";
    const normalized = "a".repeat(300) + " complete removal target";
    expect(renderEvent(plan, event(7, "redline", quote))).toBe(`#7 redline\n> ${normalized}`);
    expect(renderEvent(plan, { kind: "reply", annotationId: "a7", replyId: "r7", number: 7, quote, body: "Answer" })).toBe(`reply on #7\n> ${normalized}\nAnswer`);
    expect(messageQuote("a \n b")).toBe("a b");
  });
  it("renders an edited annotation with its full quote and new body", () => {
    expect(renderEvent(plan, { kind: "edited", annotationId: "a7", number: 7, quote: "Migrate the users table first", body: "New body", revision: 2 })).toBe("edited #7\n> Migrate the users table first\nNew body");
  });
});
