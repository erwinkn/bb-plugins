import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, HANDOFF_GUIDANCE_UPGRADES, SCALING_GUIDANCE_UPGRADES, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { projectFixture } from "./fake-native";

// T90 (A197): an ordinary native child's every ended turn sends its parent a completion notice,
// so a worker whose watcher reports each matching test line can wake the coordinator per line.
// Briefs and defaults explain this; saved defaults upgrade through one exact clause each.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const notice = "Ending your turn is not silent: for an ordinary native child, BB sends the parent thread a completion notice each time a turn ends";
const report = "When you finish or get blocked, call initiative_report with";

const oldWorkerClause = "End the turn instead of polling for more work.";
const newWorkerClause = "Ending a turn notifies a native parent, so wait for checks in-turn where supported or on your tool's single completion notification, not per-test/log watchers; when done, end the turn without polling for more work.";
const oldCoordinatorClause = "One native spawn starts real work; no Ready-only bootstrap or raw-spawn/adopt/rebrief ritual.";
const newCoordinatorClause = "One native spawn starts real work; raw starts can bypass worker identity, assignment and guidance. No Ready-only bootstrap or adopt/rebrief ritual.";
/** T96 and T101 rewrote other clauses since; undo those first (newest first) to reach the T90 texts. */
const beforeT96 = (text: string, role: "worker" | "coordinator") =>
  [...HANDOFF_GUIDANCE_UPGRADES[role], ...SCALING_GUIDANCE_UPGRADES[role]].reverse().reduce((t, [old, next]) => t.replace(next, old), text);
/** The defaults shipped before T90, pinned by hash so the derivation cannot drift. */
const previous = {
  worker: beforeT96(DEFAULT_WORKER_INSTRUCTIONS, "worker").replace(newWorkerClause, oldWorkerClause),
  coordinator: beforeT96(DEFAULT_COORDINATOR_INSTRUCTIONS, "coordinator").replace(newCoordinatorClause, oldCoordinatorClause),
};
const current = { worker: DEFAULT_WORKER_INSTRUCTIONS, coordinator: DEFAULT_COORDINATOR_INSTRUCTIONS };
const clauses = { worker: [oldWorkerClause, newWorkerClause], coordinator: [oldCoordinatorClause, newCoordinatorClause] } as const;

describe("T90 assignment briefs explain turn-end notices on every route", () => {
  async function briefs() {
    const { f, project } = await projectFixture();
    const t1 = f.task(project.id, "First");
    const [fresh] = await f.service.delegate(project.id, { route: "fresh", tasks: [t1.ref] });
    await f.service.report(fresh.threadId!, (await import("./fake-native")).report() as never);
    f.idle(fresh.threadId!);
    await f.service.delegate(project.id, { route: "continue", worker: "W1", tasks: [f.task(project.id, "Second").ref] });
    await f.service.delegate(project.id, { route: "fork", worker: "W1", tasks: [f.task(project.id, "Third").ref], forkAtSeq: 1 });
    await f.service.delegate(project.id, { route: "fresh", role: "review", reviewOf: [t1.ref] });
    const sent = f.send.mock.calls.at(-1)![0].input[0].text as string;
    return {
      fresh: f.spawn.mock.calls[0]![0].prompt as string,
      continued: sent,
      fork: f.fork.mock.calls[0]![0].input[0].text as string,
      review: f.spawn.mock.calls.at(-1)![0].prompt as string,
      ledger: f.store.assignments(project.id).map(a => a.briefText),
    };
  }

  it("fresh, continued, forked and review briefs carry the explanation after the unchanged report line", async () => {
    const b = await briefs();
    for (const [route, text] of Object.entries({ fresh: b.fresh, continued: b.continued, fork: b.fork, review: b.review })) {
      expect(text, route).toContain(notice);
      expect(text, route).toContain("forks and the report fallback keep their existing delivery");
      expect(text, route).toMatch(/Wait for your own tests and tools within the turn where the tool supports it, or on your tool's single completion notification/);
      expect(text, route).toMatch(/rather than watchers that wake you per test or log line/);
      expect(text, route).toContain("Monitors that surface actionable events, blockers or questions remain appropriate.");
      expect(text, route).toMatch(new RegExp(`${report} A\\d+ once, include evidence and a bounded handoff\\. Follow the configured worker guidance for completion; going idle is not a report\\. ${notice}`));
      expect(text, route).not.toMatch(/never use (a )?monitor|do not use monitors|exactly one notice|guarantee/i);
    }
    expect(b.review).toContain("Access: read-only.");
    expect(b.fresh).toContain("Access: write.");
    for (const text of b.ledger) expect(text).toContain(notice);
  });
});

describe("T90 default guidance", () => {
  it("previous defaults are exactly the A208 shipped texts", () => {
    expect(sha(previous.worker)).toBe("67dcd7615d363e3826516ba0cd6123b0d514e7b93918725abe26d9b38f346b94");
    expect(sha(previous.coordinator)).toBe("65c102d2b023d9cfe814488de40f498adddf3c3b37ccbe8270edbbc067041275");
  });

  it("explain turn-end notices to workers and the raw-start gap to coordinators, within the bound", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain(newWorkerClause);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain(newCoordinatorClause);
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Start fresh work directly through initiative_delegate");
    for (const text of [DEFAULT_WORKER_INSTRUCTIONS, DEFAULT_COORDINATOR_INSTRUCTIONS]) {
      expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
      for (const kept of ["Preserve errors, Stop", "Routine notices cannot be muted", "never infer"]) expect(text).toContain(kept);
      expect(text).toMatch(/one (canonical initiative_)?report/);
      expect(text).not.toMatch(/never use (a )?monitor|do not use monitors|exactly one notice|keepalive machinery to|poll every/i);
    }
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Preserve errors, Stop and ownership.");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Work follows assignment access");
  });
});

describe("T90 saved guidance upgrade", () => {
  it.each(["worker", "coordinator"] as const)("the new %s clause never contains the clause it replaces", role => {
    const [old, next] = clauses[role];
    expect(next).not.toContain(old);
  });

  it.each(["worker", "coordinator"] as const)("upgrades the previous %s default once; a second application is byte-identical", role => {
    expect(previous[role]).not.toBe(current[role]);
    const once = upgradeDecisionGuidance(previous[role], role, MAX_GUIDANCE_CHARACTERS);
    expect(once).toBe(current[role]);
    expect(upgradeDecisionGuidance(once, role, MAX_GUIDANCE_CHARACTERS)).toBe(once);
    expect(upgradeDecisionGuidance(current[role], role, MAX_GUIDANCE_CHARACTERS)).toBe(current[role]);
  });

  it.each(["worker", "coordinator"] as const)("keeps custom %s additions around the clause and leaves unrelated custom text alone", role => {
    const [old, next] = clauses[role];
    const custom = `Our deploy checklist first.\n${old}\nProfiles: always claude-code / claude-opus-5-5 / high.`;
    const upgraded = upgradeDecisionGuidance(custom, role, MAX_GUIDANCE_CHARACTERS);
    expect(upgraded).toBe(`Our deploy checklist first.\n${next}\nProfiles: always claude-code / claude-opus-5-5 / high.`);
    expect(upgradeDecisionGuidance(upgraded, role, MAX_GUIDANCE_CHARACTERS)).toBe(upgraded);
    const unrelated = "Our own process. End the turn when done. Spawn workers however we like.";
    expect(upgradeDecisionGuidance(unrelated, role, MAX_GUIDANCE_CHARACTERS)).toBe(unrelated);
    // A partial or edited clause is user-owned.
    const edited = old.replace(/\.$/, " ever.");
    expect(upgradeDecisionGuidance(edited, role, MAX_GUIDANCE_CHARACTERS)).toBe(edited);
  });

  it.each(["worker", "coordinator"] as const)("a %s upgrade that would exceed the bound keeps the saved text", role => {
    const [old] = clauses[role];
    const full = (old + "x".repeat(MAX_GUIDANCE_CHARACTERS)).slice(0, MAX_GUIDANCE_CHARACTERS);
    expect(upgradeDecisionGuidance(full, role, MAX_GUIDANCE_CHARACTERS)).toBe(full);
    // The same text with room to grow does upgrade.
    const roomy = full.slice(0, MAX_GUIDANCE_CHARACTERS - 200);
    expect(upgradeDecisionGuidance(roomy, role, MAX_GUIDANCE_CHARACTERS)).toBe(clauses[role][1] + roomy.slice(old.length));
  });

  it("a saved previous default upgrades at configuration load without waking, sending or stopping anything", async () => {
    expect(previous.worker).not.toBe(current.worker);
    const { f } = await projectFixture({ workerInstructions: previous.worker, coordinatorInstructions: previous.coordinator, executionProfiles: "{}" });
    await f.preferences.ready;
    const saved = await f.preferences.handle.get();
    expect(saved.workerInstructions).toBe(current.worker);
    expect(saved.coordinatorInstructions).toBe(current.coordinator);
    expect(saved.executionProfiles).toBe("{}");
    expect(f.send).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalled();
  });
});
