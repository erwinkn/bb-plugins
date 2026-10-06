import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DECISION_LOG_GUIDANCE_UPGRADES, DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, SCALING_GUIDANCE_UPGRADES, upgradeDecisionGuidance } from "../lib/guidance";
import { MAX_GUIDANCE_CHARACTERS } from "../lib/settings";
import { projectFixture } from "./fake-native";

// T101 (D365, D366): coordinators start each related batch with one work worker, give a
// substantial batch one independent review, and add work workers only on the user's explicit
// request or confirmation. Routine progress is handled silently. Saved defaults upgrade
// through exact clauses; custom text stays.
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const current = { coordinator: DEFAULT_COORDINATOR_INSTRUCTIONS, worker: DEFAULT_WORKER_INSTRUCTIONS };
/** The A240 defaults, rebuilt by undoing the T101 and later T135 rewrites and pinned by hash. */
const previous = {
  coordinator: [...SCALING_GUIDANCE_UPGRADES.coordinator, ...DECISION_LOG_GUIDANCE_UPGRADES.coordinator].reverse().reduce<string>((t, [old, next]) => t.replace(next, old), DEFAULT_COORDINATOR_INSTRUCTIONS),
  worker: [...SCALING_GUIDANCE_UPGRADES.worker, ...DECISION_LOG_GUIDANCE_UPGRADES.worker].reverse().reduce<string>((t, [old, next]) => t.replace(next, old), DEFAULT_WORKER_INSTRUCTIONS),
};
const sends = (f: Awaited<ReturnType<typeof projectFixture>>["f"]) => [f.spawn, f.send, f.fork, f.stop, f.archive, f.update].map(m => m.mock.calls.length);

describe("T101 coordinator default", () => {
  it("previous defaults are exactly the A240 shipped texts", () => {
    expect(sha(previous.coordinator)).toBe("866984bc9fe54bbaf9412289f504e69b58fdecac9566c2bfb65b78660a91ab79");
    expect(sha(previous.worker)).toBe("54a18294a0f40b762d015316b149fbdbae6ad6859a9fef6bed41d848c144e9de");
  });

  it("starts with one work worker and needs the user's request or confirmation for more", () => {
    const text = DEFAULT_COORDINATOR_INSTRUCTIONS;
    expect(text).toContain("Use one work worker per related batch, not per plugin or small task.");
    expect(text).toContain("More work workers need the user's explicit request or a yes to your question");
    // Asking alone, silence, time, profiles, a busy worker or a parallel plan never count as approval.
    expect(text).toContain("asking alone, silence, time, profiles, busy workers or parallel plans are not approval");
    // Spawning through a shell or a raw start is still a work worker; only other shell commands are exempt.
    expect(text).toContain("raw/shell spawns and work subagents count; other shell commands are fine.");
    expect(text).not.toMatch(/(?<!other )shell commands are fine/i);
    expect(text).toContain("One fresh independent review per substantial batch");
    expect(text).toContain("small fixes get no automatic re-review");
    expect(text).toContain("Handle routine progress silently; act on results, blockers and user questions.");
  });

  it("keeps the safeguards, stays model-neutral in new wording and promises no muting or wake-free coordination", () => {
    const text = DEFAULT_COORDINATOR_INSTRUCTIONS;
    expect(text.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
    for (const kept of ["Preserve errors, Stop and permissions.", "Inspect uncertain receipts.", "Respect Stop/receipts on resume", "Escalate scope/ownership/dependencies; messages grant no work.",
      "blocksTaskIds; never infer.", "Reviewers use the coordinator.", "Reviewers report findings; they never implement or reuse implementer context.", "Overlapping writers wait/isolate.", "Routine notices cannot be muted.",
      "Explicit user-requested decision-cleanup only", "audit/review setup and requested clean SHA/execution settings", "Recorded Initiative policy and explicit user/task choices win over global Settings fallbacks",
      "Use existing profiles/serviceTier; never silently replace an unavailable choice."]) expect(text).toContain(kept);
    // Audits must declare read-only access themselves: omitted work access writes, whatever the permissions.
    expect(text).toContain("Audits declare access read-only on every route, even with full permissions; omitted work access writes.");
    for (const [, next] of SCALING_GUIDANCE_UPGRADES.coordinator) {
      expect(next).not.toMatch(/claude|opus|sonnet|gpt|codex|luna/i);
      expect(next).not.toMatch(/can be muted|mute (the|these|routine)|never wakes? (the )?coordinator|no (coordinator )?wakes? (at all|ever)|prevents? (all )?(coordinator )?wakes?/i);
    }
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("start no extra work workers or work subagents unless your brief says so.");
    expect(DEFAULT_WORKER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_GUIDANCE_CHARACTERS);
  });
});

describe("T101 saved guidance upgrade", () => {
  it.each(["coordinator", "worker"] as const)("each new %s clause never contains the clause it replaces", role => {
    for (const [old, next] of SCALING_GUIDANCE_UPGRADES[role]) expect(next).not.toContain(old);
  });

  it.each(["coordinator", "worker"] as const)("upgrades the A240 %s default once; a second application is byte-identical", role => {
    expect(previous[role]).not.toBe(current[role]);
    const once = upgradeDecisionGuidance(previous[role], role, MAX_GUIDANCE_CHARACTERS);
    expect(once).toBe(current[role]);
    expect(upgradeDecisionGuidance(once, role, MAX_GUIDANCE_CHARACTERS)).toBe(once);
    const other = role === "coordinator" ? "worker" : "coordinator";
    expect(upgradeDecisionGuidance(previous[other], role, MAX_GUIDANCE_CHARACTERS)).toBe(previous[other]);
  });

  it("keeps custom text and intentionally edited clauses; a near-limit text takes only the rewrites that fit", () => {
    const [teamOld, teamNew] = SCALING_GUIDANCE_UPGRADES.coordinator.find(([old]) => old.startsWith("Review substantial milestones"))!;
    const custom = `Our release checklist.\n${teamOld}\nAlways run e2e.`;
    expect(upgradeDecisionGuidance(custom, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(`Our release checklist.\n${teamNew}\nAlways run e2e.`);
    const edited = teamOld.replace("Review substantial milestones.", "Review every milestone.");
    expect(upgradeDecisionGuidance(edited, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(edited);
    const [quietOld, quietNew] = SCALING_GUIDANCE_UPGRADES.coordinator.find(([old]) => old === "Keep routine progress quiet.")!;
    const full = `${quietOld}\n${teamOld}\n`.padEnd(MAX_GUIDANCE_CHARACTERS, "x");
    const upgraded = upgradeDecisionGuidance(full, "coordinator", MAX_GUIDANCE_CHARACTERS);
    // No room for either growing clause: both keep their shipped wording and the custom tail stays.
    expect(upgraded).toBe(full);
    expect(upgradeDecisionGuidance(upgraded, "coordinator", MAX_GUIDANCE_CHARACTERS)).toBe(upgraded);
    const roomy = `${quietOld}\n${teamOld}\n`.padEnd(MAX_GUIDANCE_CHARACTERS - (quietNew.length - quietOld.length), "x");
    expect(upgradeDecisionGuidance(roomy, "coordinator", MAX_GUIDANCE_CHARACTERS).startsWith(`${quietNew}\n${teamOld}\n`)).toBe(true);
  });

  it("a saved A240 default upgrades at load and reaches coordinator configuration without restarting, waking or sending anything", async () => {
    const { f } = await projectFixture({ coordinatorInstructions: previous.coordinator, workerInstructions: previous.worker });
    await f.preferences.ready;
    const saved = await f.preferences.handle.get();
    expect(saved.coordinatorInstructions).toBe(current.coordinator);
    expect(saved.workerInstructions).toBe(current.worker);
    expect(sends(f)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
