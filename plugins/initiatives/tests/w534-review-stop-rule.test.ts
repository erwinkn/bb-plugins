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
    expect(worker).toContain("one fresh reviewer each round");
    expect(worker).toContain("Ask for a verdict (correct or needs attention) and findings ranked P1 to P3.");
    expect(worker).toContain("Clean means the verdict is correct with no P1 or P2.");
    expect(worker).toContain("Once only P3s remain, fix the cheap ones, list the rest in your PR notes (initiative_pr) and report done: no re-review to confirm P3 fixes.");
    expect(worker).toContain("no round cap");
    expect(worker).toContain("whack-a-mole (P1s, or P2s reappearing in the same area round after round) or scope creep");
    expect(worker).toContain("If your brief asks for a second reviewer (Fable 5.1), consult it once, after the first has passed the head. Done when the last verdict is clean.");
  });

  it("coordinator: done means verdict correct with no P1 or P2; a second reviewer (Fable 5.1) only for high-risk changes, once, in sequence", () => {
    const coordinator = flat(DEFAULT_COORDINATOR_INSTRUCTIONS);
    expect(coordinator).toContain("done (clean review: verdict correct, no P1 or P2)");
    expect(coordinator).toContain("Each review round uses one reviewer.");
    expect(coordinator).toContain("high-risk change (auth, locking, migrations, crypto, concurrency)");
    expect(coordinator).toContain("Fable 5.1, asked once, after the first reviewer has passed the head");
    expect(coordinator).toContain("Never require both clean on the same head.");
  });

  it("the skills and README agree", () => {
    const worker = skill("initiative-worker");
    expect(worker).toContain("A review is clean when the verdict is correct with no P1 or P2.");
    expect(worker).toContain("list the rest in your PR notes and report done; don't re-review to confirm P3 fixes.");
    expect(worker).toContain("If your brief asks for a second reviewer (Fable 5.1), consult it once, after the first has passed the head.");
    const coordinator = skill("initiative-coordinator");
    expect(coordinator).toContain("one fresh reviewer from the other model family per round");
    expect(coordinator).toContain("Never require both clean on the same head.");
    expect(flat(readFileSync("README.md", "utf8"))).toContain("means the reviewer's verdict is correct with no P1 or P2");
  });

  it.each(["coordinator", "worker"] as const)("the %s default from before R8 is kept as a legacy text and upgrades to the current one", async (field) => {
    const previous = PREVIOUS_DEFAULTS[field][0]!;
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
