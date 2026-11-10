import { describe, expect, it } from "vitest";
import { DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { fixture } from "./fake-native";

// W579 (audit, W281): a worker fixed and committed three P1s before rereading the brief's
// "if a round finds X, stop and report". The stop conditions are checked before any edit.
describe("W579 brief stop conditions come before fixes", () => {
  it("the worker default says to check them first and that they beat fixing and re-reviewing", () => {
    const worker = DEFAULT_WORKER_INSTRUCTIONS.replace(/\s+/g, " ");
    expect(worker).toContain("When a review round comes back, first check your brief's stop conditions");
    expect(worker).toContain("If one is triggered, stop before editing: no fixes, no commit, report blocked with the findings and the options.");
    expect(worker).toContain('A stop condition beats "fix the findings" and "keep reviewing".');
  });

  it("the worker default from before it is kept as a legacy text and upgrades to the current one", async () => {
    const previous = PREVIOUS_DEFAULTS.worker[1]!;
    expect(previous).toContain("- Fix the findings you agree with. If you disagree");
    expect(previous).not.toContain("stop conditions");
    const f = fixture({ workerInstructions: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration().workerInstructions).toBe(DEFAULT_WORKER_INSTRUCTIONS);
    expect(PREVIOUS_DEFAULTS.worker).not.toContain(DEFAULT_WORKER_INSTRUCTIONS);
  });
});
