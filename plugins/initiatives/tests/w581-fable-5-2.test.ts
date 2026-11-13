import { describe, expect, it } from "vitest";
import { DEFAULT_COORDINATOR_INSTRUCTIONS, DEFAULT_WORKER_INSTRUCTIONS, GUIDANCE_RESET_FLAG, PREVIOUS_DEFAULTS } from "../lib/guidance";
import { DEFAULT_PROFILES } from "../lib/schema";
import { fixture } from "./fake-native";

// W581 (Erwin, 2026-11-10): the expert reviewer moved from Fable 5.1 to Fable 5.2.
describe("W581 Fable 5.2 reviewer", () => {
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
    const previous = PREVIOUS_DEFAULTS[field][1]!;
    expect(previous).toContain("Fable 5.1");
    expect(previous).not.toContain("Fable 5.2");
    expect(previous.replaceAll("Fable 5.1", "Fable 5.2")).toBe(PREVIOUS_DEFAULTS[field][0]);
    const f = fixture({ [key]: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()[key]).toBe(current);
    expect(PREVIOUS_DEFAULTS[field]).not.toContain(current);
  });
});

// Oracle for Erwin (2026-11-13): "Fable is only when you have a complex change that truly
// needs a senior engineer on it". The expert is rare and named by its question; an ordinary
// review of GPT work runs on Opus.
describe("expert reviewer is rare", () => {
  it("the GPT-work reviewer profile is Opus 5.5 at high", () => {
    expect(DEFAULT_PROFILES.reviewOfGpt).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
  });

  it("the coordinator text no longer lists topics as triggers and asks for the hard question", () => {
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).not.toContain("auth, locking, migrations, crypto, concurrency");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("additive migrations");
    expect(DEFAULT_COORDINATOR_INSTRUCTIONS).toContain("Write that question in the brief");
  });

  it("the worker text forbids an expert the brief did not name", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Never pick Fable or another expert yourself");
  });

  it.each([
    ["coordinator", "coordinatorInstructions", DEFAULT_COORDINATOR_INSTRUCTIONS],
    ["worker", "workerInstructions", DEFAULT_WORKER_INSTRUCTIONS],
  ] as const)("the saved %s default from before upgrades to the new text", async (field, key, current) => {
    const previous = PREVIOUS_DEFAULTS[field][0]!;
    expect(previous).not.toBe(current);
    const f = fixture({ [key]: previous });
    f.store.setFlag(GUIDANCE_RESET_FLAG);
    await f.preferences.ready;
    expect(f.preferences.configuration()[key]).toBe(current);
  });
});
