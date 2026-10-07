import { CACHE_TTL_MS, type CacheTtl } from "./cache-usage.js";

// Whether the next refresh is worth sending, from what the thread is waiting on.
//
// Costs are in units of C, the prefix a lease keeps warm, at the price ratios usage-report.ts uses
// (INPUT_EQUIVALENT_WEIGHTS): a refresh reads the prefix (r = 0.1); a resume after the entry
// expired writes it instead of reading it (m = 1.25 - 0.1 at 5m, 2 - 0.1 at 1h). The entry already
// lasts until wait age c. Refreshes sent at ages a, a + step, ... (step = TTL - safetyMargin) keep
// it until a + (n-1)*step + TTL after n of them. Each costs r if the thread is still waiting when it
// is due, and they save m only for a resume after c. With S(t) the chance that a wait lasts longer
// than t:
//
//   net(n) = m * (S(c) - S(a + (n-1)*step + TTL)) - r * sum_{j<n} S(a + j*step)   (all over S(a))
//
// The warmer refreshes while some n has a positive net, and decides again at every refresh. So it
// never counts the refreshes already spent, and a wait that usually ends soon is warmed through a
// dip in its odds. C cancels out: only the wait's state, its role and its age matter.
//
// A thread mid-turn (state "tool") resumes once its tool returns, and one with a background task
// running resumes when the task reports back, so both are warmed regardless of the odds: until
// maxWaitMinutes mid-turn, until maxBackgroundWaitMinutes for a background task (most that run
// longer never lead to a resume). The warmer stops a lease whose background task ended without a
// resume. For a question or an ended turn, S
// comes from observed waits of the same state and role: the prior below plus the ledger's own
// history (readResumeSamples), each role's waits shrunk toward its state's.
//
// Pi (earendil-works/pi-coding-agent 1.0.4, core/cache-warmer.js) makes the same comparison one
// refresh at a time: refresh while P(resume before expiry) * missCost - warmCost >= $0.05, with
// P = 1 while the agent runs and 0.15 when idle, and a 60/30-minute cap. This adds the lookahead and
// replaces the constant with odds measured per waiting state and role.

export const waitStates = ["tool", "background", "question", "idle"] as const;
export type WaitState = (typeof waitStates)[number];

export const warmingRoles = [
  "coordinator",
  "worker",
  "reviewer",
  "standalone",
] as const;
export type WarmingRole = (typeof warmingRoles)[number];

const REFRESH_COST = 0.1;
const WRITE_COST: Record<CacheTtl, number> = { "5m": 1.25, "1h": 2 };
// How many of its state's waits a role's own waits are worth, while they are few.
const SHRINK = 5;

// What a thread is waiting on, from BB's thread list row. A pending question comes first: the turn
// may still be open while it waits for an answer.
export function waitStateOf(thread: {
  status: string;
  hasPendingInteraction: boolean;
  activity: {
    activeBackgroundCommandCount: number;
    activeBackgroundAgentCount: number;
  };
}): WaitState {
  if (thread.hasPendingInteraction) return "question";
  if (thread.status === "active" || thread.status === "starting") return "tool";
  const { activeBackgroundCommandCount, activeBackgroundAgentCount } =
    thread.activity;
  if (activeBackgroundCommandCount + activeBackgroundAgentCount > 0)
    return "background";
  return "idle";
}

// One observed wait: from the completion of the native request a lease kept warm to the next native
// request of its session, or null when none came.
export interface ResumeSample {
  state: WaitState;
  role: WarmingRole;
  waitMs: number | null;
}

export class ResumeHistory {
  // Sorted wait lengths; Infinity for a wait that never resumed.
  private readonly byRole = new Map<string, number[]>();
  private readonly byState = new Map<WaitState, number[]>();

  constructor(samples: Iterable<ResumeSample>) {
    for (const sample of samples) {
      const wait = sample.waitMs ?? Number.POSITIVE_INFINITY;
      push(this.byRole, `${sample.state}/${sample.role}`, wait);
      push(this.byState, sample.state, wait);
    }
    for (const list of [...this.byRole.values(), ...this.byState.values()])
      list.sort((left, right) => left - right);
  }

  size(state: WaitState, role: WarmingRole): number {
    return this.byRole.get(`${state}/${role}`)?.length ?? 0;
  }

  // P(wait > t | wait > age), the role's own waits shrunk toward the state's. Past every observed
  // wait of the state there is no evidence of a resume, so the wait is taken to go on.
  survival(state: WaitState, role: WarmingRole, age: number, t: number): number {
    const own = this.byRole.get(`${state}/${role}`) ?? [];
    const pooled = this.byState.get(state) ?? [];
    const pooledAlive = longer(pooled, age);
    const prior = pooledAlive === 0 ? 1 : longer(pooled, t) / pooledAlive;
    return (longer(own, t) + SHRINK * prior) / (longer(own, age) + SHRINK);
  }
}

export interface RefreshDecision {
  refresh: boolean;
  // Chance the thread resumes within the horizon, once it has waited this long.
  resumeChance: number;
  // Expected saving of warming through the horizon, in units of the prefix (net(n) above).
  net: number;
  horizonMs: number;
  why: string;
}

export function decideRefresh(
  history: ResumeHistory,
  wait: {
    state: WaitState;
    role: WarmingRole;
    ageMs: number;
    // The wait age the entry already lasts until.
    coveredMs: number;
    stepMs: number;
    ttl: CacheTtl;
    maxAgeMs: number;
    maxBackgroundAgeMs: number;
  },
): RefreshDecision {
  const miss = WRITE_COST[wait.ttl] - REFRESH_COST;
  const ttlMs = CACHE_TTL_MS[wait.ttl];
  const { state, role, ageMs, coveredMs, stepMs, maxAgeMs } = wait;
  if (ageMs >= maxAgeMs)
    return {
      refresh: false,
      resumeChance: 0,
      net: 0,
      horizonMs: 0,
      why: `the wait reached maxWaitMinutes (${Math.round(maxAgeMs / 60_000)})`,
    };
  if (state === "background" && ageMs >= wait.maxBackgroundAgeMs)
    return {
      refresh: false,
      resumeChance: 0,
      net: 0,
      horizonMs: 0,
      why: `the background wait reached maxBackgroundWaitMinutes (${Math.round(wait.maxBackgroundAgeMs / 60_000)})`,
    };
  if (state === "tool" || state === "background")
    return {
      refresh: true,
      resumeChance: 1,
      net: miss - REFRESH_COST,
      horizonMs: ttlMs,
      why:
        state === "tool"
          ? "mid-turn: the turn resumes when its tool returns"
          : "a background task is running: the thread resumes when it reports back",
    };
  let best: RefreshDecision = {
    refresh: false,
    resumeChance: 0,
    net: Number.NEGATIVE_INFINITY,
    horizonMs: ttlMs,
    why: "",
  };
  // Resumes before the current expiry need no refresh.
  const uncovered = history.survival(state, role, ageMs, coveredMs);
  let cost = 0;
  let due = 1;
  // The n-th refresh of the plan is sent at ageMs + (n - 1) * stepMs, which must be before maxAgeMs.
  for (let n = 1; ageMs + (n - 1) * stepMs < maxAgeMs; n += 1) {
    cost += REFRESH_COST * due;
    const horizon = ageMs + (n - 1) * stepMs + ttlMs;
    const saved = Math.max(0, uncovered - history.survival(state, role, ageMs, horizon));
    due = history.survival(state, role, ageMs, ageMs + n * stepMs);
    const net = miss * saved - cost;
    if (net > best.net)
      best = {
        refresh: net > 0,
        resumeChance: saved,
        net,
        horizonMs: horizon - ageMs,
        why: "",
      };
  }
  const odds = `P(resume between expiry and ${Math.round(best.horizonMs / 60_000)} min from now) ${best.resumeChance.toFixed(2)} from ${history.size(state, role)} ${state}/${role} waits`;
  return {
    ...best,
    why: best.refresh
      ? `${odds}, expected net +${best.net.toFixed(2)}×prefix`
      : `expected savings no longer cover refreshes: ${odds}`,
  };
}

// Waits observed in the ledger before warming kept any history of its own (2026-10-05 to 10-07,
// the T141 back-test), in minutes, null for no resume within 3 h: up to 20 quantiles of the waits
// that reached a first refresh decision, per state and role. Mid-turn and background waits are not
// needed: both are warmed until maxWaitMinutes.
const PRIOR_MINUTES: Partial<Record<`${WaitState}/${WarmingRole}`, Array<number | null>>> = {
  "idle/coordinator": [5.1, 5.2, 6.5, 6.7, 6.8, 7.0, 7.1, 7.9, 9.6, 10.4, 10.4, 12.8, 13.6, 14.5, 29.6, 39.5, 42.3, 528.5, null, null],
  "idle/reviewer": [null],
  "idle/standalone": [null, null, null, null],
  "idle/worker": [15.0, null, null, null],
  "question/coordinator": [4.8, 5.0, 10.3, 11.8, 28.1, 35.8, 604.4, null, null],
};

export const PRIOR_SAMPLES: ResumeSample[] = Object.entries(PRIOR_MINUTES).flatMap(
  ([key, minutes]) => {
    const [state, role] = key.split("/") as [WaitState, WarmingRole];
    return (minutes ?? []).map((value) => ({
      state,
      role,
      waitMs: value === null ? null : value * 60_000,
    }));
  },
);

function push<K>(map: Map<K, number[]>, key: K, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

// How many of the sorted values are greater than t.
function longer(sorted: number[], t: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! <= t) low = middle + 1;
    else high = middle;
  }
  return sorted.length - low;
}
