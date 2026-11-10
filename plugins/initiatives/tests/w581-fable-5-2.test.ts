import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { DEFAULT_PROFILES } from "../lib/schema";
import { fixture } from "./fake-native";

// W581 (Erwin, 2026-11-10): the expert reviewer moved from Fable 5.1 to Fable 5.2.
describe("W581 Fable 5.2 reviewer", () => {
  it("the GPT-work reviewer profile is Fable 5.2 at xhigh", () => {
    expect(DEFAULT_PROFILES.reviewOfGpt).toEqual({ providerId: "claude-code", model: "claude-fable-5-2", reasoningLevel: "xhigh" });
  });

  it("the defaults name Fable 5.2 and no longer Fable 5.1", () => {
    for (const text of [DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS]) {
      expect(text).toContain("Fable 5.2");
      expect(text).not.toContain("Fable 5.1");
    }
  });

  it.each([
    ["coordinator", "coordinatorInstructions", DEFAULT_COORDINATOR_INSTRUCTIONS],
    ["worker", "workerInstructions", DEFAULT_WORKER_INSTRUCTIONS],
  ] as const)("the %s default from before is kept as a legacy text and upgrades to the current one", async (field, key, current) => {
    const previous = PREVIOUS_DEFAULTS[field][0]!;
    expect(previous).toContain("Fable 5.1");
    expect(previous).not.toContain("Fable 5.2");
    expect(previous.replaceAll("Fable 5.1", "Fable 5.2")).toBe(current);
    const f = fixture({ [key]: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()[key]).toBe(current);
    expect(PREVIOUS_DEFAULTS[field]).not.toContain(current);
  });
});
