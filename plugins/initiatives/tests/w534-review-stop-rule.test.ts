import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { fixture } from "./fake-native";

// W534 (rule R8, Erwin 2026-10-20): a review is clean when the verdict is correct with no P1 or
// P2; a P3-only round has converged; one reviewer per round by default.
const flat = (text: string) => text.replace(/\s+/g, " ");
const skill = (name: string) => flat(readFileSync(`skills/${name}/SKILL.md`, "utf8"));

describe("W534 review stop rule", () => {
  it("worker: clean means correct with no P1 or P2, P3s are listed and not re-reviewed, one reviewer, a verdict and P1-P3 asked for", () => {
    const worker = flat(DEFAULT_WORKER_INSTRUCTIONS);
    expect(worker).toContain("one fresh reviewer from the other model family");
    expect(worker).toContain("Ask for a verdict (correct or needs attention) and findings ranked P1 to P3, grouped by root cause with every instance.");
    expect(worker).toContain("Clean means verdict correct, no P1 or P2.");
    expect(worker).toContain("Once only P3s remain, fix the cheap ones, list the rest in your PR notes (initiative_pr) and report done: no re-review to confirm P3 fixes.");
    expect(worker).not.toContain("whack-a-mole");
    expect(worker).toContain("If your brief asks for an expert second reviewer (Fable 5.1, or Muse Wonder Full: muse-wonder-full-1.0, xhigh), consult it once, after the first has passed the head. Done when the last verdict is clean.");
  });

  it("coordinator: done means verdict correct with no P1 or P2; a second reviewer (Fable 5.1) only for high-risk changes, once, in sequence", () => {
    const coordinator = flat(DEFAULT_COORDINATOR_INSTRUCTIONS);
    expect(coordinator).toContain("done (clean review: verdict correct, no P1 or P2)");
    expect(coordinator).toContain("Each review round uses one reviewer.");
    expect(coordinator).toContain("high-risk change (auth, money, locking, migrations, crypto, concurrency)");
    expect(coordinator).toContain("Fable 5.1 or Muse Wonder Full, asked once, after the first reviewer has passed the head");
    expect(coordinator).toContain("Never require both clean on the same head.");
  });

  it("the skills and README agree", () => {
    const worker = skill("initiative-worker");
    expect(worker).toContain("A review is clean when the verdict is correct with no P1 or P2.");
    expect(worker).toContain("list the rest in your PR notes and report done; don't re-review to confirm P3 fixes.");
    expect(worker).toContain("If your brief asks for an expert second reviewer (Fable 5.1, or Muse Wonder Full: muse-wonder-full-1.0, xhigh), consult it once, after the first has passed the head;");
    const coordinator = skill("initiative-coordinator");
    expect(coordinator).toContain("one fresh reviewer from the other model family per round");
    expect(coordinator).toContain("Never require both clean on the same head.");
    expect(flat(readFileSync("README.md", "utf8"))).toContain("means the reviewer's verdict is correct with no P1 or P2");
  });

  // Erwin (2026-11-07): the repository's review-loop skill owns the loop; the plugin's default states
  // the same stop rule; reviewers group findings by root cause; high-risk or multi-PR work starts
  // with a design the expert reviews once.
  it("the repository's review-loop skill owns the loop; the default accounts for deletions, sweeps each cause and stops when a round doesn't shrink", () => {
    const worker = flat(DEFAULT_WORKER_INSTRUCTIONS);
    expect(worker).toContain("Review with the repository's review-loop skill if it has one (such as autoreview): it owns the stop rule.");
    expect(worker).toContain("grouped by root cause with every instance");
    expect(worker).toContain("No such skill: before round 1, say where each deleted or moved branch, filter, check or field now does its job, or why nothing needs it.");
    expect(worker).toContain("Fix each cause and sweep for more instances; ask the next reviewer if each is closed and the delta clean.");
    expect(worker).not.toMatch(/from round \d/i);
    const coordinator = flat(DEFAULT_COORDINATOR_INSTRUCTIONS);
    expect(coordinator).toContain("Such a change, or a feature over several PRs, starts with a design the brief asks for: a short artifact (data model, one worked example, failure cases) the expert reviews once before coding.");
    expect(skill("initiative-worker")).toContain("Keep going only while each round has fewer and smaller findings and none caused by the previous fix.");
    expect(skill("initiative-coordinator")).toContain("the brief also asks for a design first");
  });

  it.each(["coordinator", "worker"] as const)("the %s default from before R8 is kept as a legacy text and upgrades to the current one", async (field) => {
    const previous = field === "coordinator" ? PREVIOUS_DEFAULTS.coordinator.find((text) => text.includes("done (clean review) or blocked"))! : PREVIOUS_DEFAULTS.worker.find((text) => text.includes("a fresh reviewer each round"))!;
    expect(previous).toContain("Initiative");
    expect(previous).not.toContain("no P1 or P2");
    expect(previous).not.toContain("P1 to P3");
    expect(previous).toContain(field === "coordinator" ? "done (clean review) or blocked" : "Done when the last verdict is clean.");
    const key = field === "coordinator" ? "coordinatorInstructions" : "workerInstructions";
    const f = fixture({ [key]: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    const current = field === "coordinator" ? DEFAULT_COORDINATOR_INSTRUCTIONS : DEFAULT_WORKER_INSTRUCTIONS;
    expect(f.preferences.configuration()[key]).toBe(current);
    expect(PREVIOUS_DEFAULTS[field]).not.toContain(current);
  });
});
