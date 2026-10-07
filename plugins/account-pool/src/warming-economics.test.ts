import { describe, expect, it } from "vitest";
import {
  decideRefresh,
  PRIOR_SAMPLES,
  ResumeHistory,
  waitStateOf,
  type ResumeSample,
  type WaitState,
  type WarmingRole,
} from "./warming-economics.js";

const MINUTE = 60_000;
const STEP = 4 * MINUTE;

function samples(
  state: WaitState,
  role: WarmingRole,
  minutes: Array<number | null>,
): ResumeSample[] {
  return minutes.map((value) => ({
    state,
    role,
    waitMs: value === null ? null : value * MINUTE,
  }));
}

function decide(
  history: ResumeHistory,
  state: WaitState,
  role: WarmingRole,
  ageMinutes: number,
  overrides: {
    ttl?: "5m" | "1h";
    maxAgeMinutes?: number;
    maxBackgroundAgeMinutes?: number;
    stepMs?: number;
    coveredMinutes?: number;
  } = {},
) {
  return decideRefresh(history, {
    state,
    role,
    ageMs: ageMinutes * MINUTE,
    // Due a 60-second safety margin before the entry expires.
    coveredMs: (overrides.coveredMinutes ?? ageMinutes + 1) * MINUTE,
    stepMs: overrides.stepMs ?? STEP,
    ttl: overrides.ttl ?? "5m",
    maxAgeMs: (overrides.maxAgeMinutes ?? 60) * MINUTE,
    maxBackgroundAgeMs: (overrides.maxBackgroundAgeMinutes ?? 60) * MINUTE,
  });
}

// How many refreshes a wait of this state and role gets before warming stops, if it never resumes.
function refreshesUntilStop(history: ResumeHistory, state: WaitState, role: WarmingRole): number {
  let count = 0;
  for (let age = 3.5; decide(history, state, role, age).refresh; age += 4) count += 1;
  return count;
}

describe("waitStateOf", () => {
  const row = (overrides: Partial<Parameters<typeof waitStateOf>[0]> = {}) => ({
    status: "idle",
    hasPendingInteraction: false,
    activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 0 },
    ...overrides,
  });

  it.each([
    ["a pending question, even mid-turn", row({ status: "active", hasPendingInteraction: true }), "question"],
    ["a turn in progress", row({ status: "active" }), "tool"],
    ["a turn starting", row({ status: "starting" }), "tool"],
    ["a background command after the turn", row({ activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } }), "background"],
    ["a background agent after the turn", row({ activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 2 } }), "background"],
    ["an ended turn", row(), "idle"],
    ["a failed turn", row({ status: "error" }), "idle"],
  ] as const)("reads %s", (_name, thread, state) => {
    expect(waitStateOf(thread)).toBe(state);
  });
});

describe("decideRefresh", () => {
  const empty = new ResumeHistory([]);

  it("always refreshes mid-turn or while a background task runs, and never once the wait reached maxWaitMinutes", () => {
    for (const state of ["tool", "background"] as const) {
      expect(decide(empty, state, "worker", 3.5)).toMatchObject({ refresh: true, resumeChance: 1 });
      expect(decide(empty, state, "worker", 59)).toMatchObject({ refresh: true });
      expect(decide(empty, state, "worker", 60)).toMatchObject({
        refresh: false,
        why: "the wait reached maxWaitMinutes (60)",
      });
    }
    // A background wait stops at its own limit; a mid-turn one does not.
    expect(decide(empty, "background", "worker", 20, { maxBackgroundAgeMinutes: 20 })).toMatchObject({
      refresh: false,
      why: "the background wait reached maxBackgroundWaitMinutes (20)",
    });
    expect(decide(empty, "tool", "worker", 20, { maxBackgroundAgeMinutes: 20 }).refresh).toBe(true);
    // Sampled odds never apply to a running background task.
    const never = new ResumeHistory(samples("background", "worker", Array(50).fill(null)));
    expect(decide(never, "background", "worker", 30)).toMatchObject({
      refresh: true,
      why: "a background task is running: the thread resumes when it reports back",
    });
  });

  it("credits only resumes after the current expiry", () => {
    // W211: due at minute 4, the entry lasts until minute 5, and every wait resumes at 4.5.
    const early = new ResumeHistory(samples("idle", "worker", Array(20).fill(4.5)));
    expect(decide(early, "idle", "worker", 4, { coveredMinutes: 5 })).toMatchObject({ refresh: false, resumeChance: 0 });
    // Resumes at 5.5 are after the expiry and within the refreshed entry.
    const later = new ResumeHistory(samples("idle", "worker", Array(20).fill(5.5)));
    expect(decide(later, "idle", "worker", 4, { coveredMinutes: 5 })).toMatchObject({ refresh: true, resumeChance: 1 });
  });

  it("warms through steps with no resume when a resume cluster follows", () => {
    // Every wait resumes at 14 minutes: the next two refreshes save nothing by themselves, but
    // three refreshes (0.3) keep the entry until 16.5 minutes and buy a sure 1.15.
    const history = new ResumeHistory(samples("idle", "coordinator", Array(20).fill(14)));
    const at = decide(history, "idle", "coordinator", 3.5);
    expect(at).toMatchObject({ refresh: true, horizonMs: 13 * MINUTE, resumeChance: 1 });
    expect(at.net).toBeCloseTo(1.15 - 0.3);
    // Past every observed wait there is no evidence of a resume.
    expect(decide(history, "idle", "coordinator", 15)).toMatchObject({ refresh: false });
  });

  it("stops when resumes are too rare to repay a refresh", () => {
    // One in twenty resumes within the next step: 1.15 / 20 < 0.1.
    const history = new ResumeHistory(samples("idle", "standalone", [5, ...Array(19).fill(null)]));
    const at = decide(history, "idle", "standalone", 3.5);
    expect(at.refresh).toBe(false);
    expect(at.why).toMatch(/^expected savings no longer cover refreshes: P\(resume between expiry and 5 min from now\) 0\.05 from 20 idle\/standalone waits$/);
  });

  it("weighs a 1h entry's rewrite at 2x, so rarer resumes still pay", () => {
    // One in twelve resumes within the step: 1.15 / 12 < 0.1 at 5m, 1.9 / 12 > 0.1 at 1h.
    const history = new ResumeHistory(samples("question", "coordinator", [5, ...Array(11).fill(null)]));
    expect(decide(history, "question", "coordinator", 3.5).refresh).toBe(false);
    expect(decide(history, "question", "coordinator", 3.5, { ttl: "1h" }).refresh).toBe(true);
  });

  it("shrinks a role with few waits toward its state's", () => {
    const history = new ResumeHistory([
      ...samples("idle", "coordinator", Array(40).fill(6)),
      ...samples("idle", "reviewer", [null]),
    ]);
    // One reviewer wait that never resumed is outweighed by 40 coordinator waits that did: the
    // state's survival 1/41 counts as 5 waits next to the reviewer's own one.
    expect(history.survival("idle", "reviewer", 3.5 * MINUTE, 7.5 * MINUTE)).toBeCloseTo((1 + 5 / 41) / 6);
    expect(decide(history, "idle", "reviewer", 3.5).refresh).toBe(true);
    // Forty reviewer waits that never resumed are not.
    const many = new ResumeHistory([
      ...samples("idle", "coordinator", Array(40).fill(6)),
      ...samples("idle", "reviewer", Array(40).fill(null)),
    ]);
    expect(decide(many, "idle", "reviewer", 3.5).refresh).toBe(false);
  });
});

describe("the built-in history", () => {
  const history = new ResumeHistory(PRIOR_SAMPLES);

  it("gives an idle coordinator, which workers' reports wake, better odds than an idle standalone thread", () => {
    const coordinator = decide(history, "idle", "coordinator", 3.5);
    const standalone = decide(history, "idle", "standalone", 3.5);
    expect(coordinator.resumeChance).toBeGreaterThan(standalone.resumeChance);
    expect(refreshesUntilStop(history, "idle", "coordinator")).toBeGreaterThan(0);
  });

  it("has samples for the states judged by odds only", () => {
    const states = new Set(PRIOR_SAMPLES.map((sample) => sample.state));
    expect([...states].sort()).toEqual(["idle", "question"]);
  });
});
