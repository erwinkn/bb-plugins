import { hasSpokenWords } from "./spoken-input.ts";

export const INPUT_QUIET_MS = 800;
export const EFFECT_QUIET_MS = 2000;
export const FINAL_TRANSCRIPT_MS = 4000;
export const UTTERANCE_MERGE_MS = 5000;
export type InputView = {
  threadId: string | null;
  projectId: string | null;
  onNewThreadScreen: boolean;
};
export interface InputItem {
  id: string;
  text: string;
  final: string | null;
  state: "open" | "committing" | "committed" | "final" | "failed";
  startedAt: number;
  endedAt: number;
  committedAt: number | null;
  confirmed: boolean;
  utteranceId: string | null;
  version: number;
  view: InputView;
}
export interface UtteranceSnapshot {
  id: string;
  version: number;
  items: readonly { itemId: string; text: string }[];
  text: string;
  view: InputView;
  finalAt: number;
}
interface Utterance {
  id: string;
  version: number;
  items: InputItem[];
  finalAt: number;
  closed: boolean;
  repairOffered: boolean;
}
interface InputHost {
  now(): number;
  view(): InputView;
  send(event: Record<string, unknown>): boolean;
  changed(): void;
  interrupt(item: InputItem): void;
  draft(item: InputItem): void;
  final(item: InputItem, late: boolean): void;
  repair(message: string): void;
  log(kind: string, data: Record<string, unknown>): void;
}

/** Owns input identity and timing. Audio chunks, visible utterances and effects
 * have separate boundaries. No other component maintains a transcript cursor.
 */
export class InputController {
  private items = new Map<string, InputItem>();
  private current: Utterance | null = null;
  private counter = 0;
  private requested = 0;
  private events = new Set<string>();
  private disposed = false;
  private available = true;
  private repairOfferedSinceSuccess = false;
  private energyAt = -Infinity;
  private energySince: number | null = null;
  private supportedUntil = -Infinity;
  private supportedSince = Infinity;
  private detectedView: InputView | null = null;
  private waiters = new Set<{
    version: number;
    effect: boolean;
    resolve: (snapshot: UtteranceSnapshot | null) => void;
  }>();
  constructor(private host: InputHost) {}
  get version() {
    return this.current?.version ?? 0;
  }
  get speaking() {
    return this.energySince !== null && this.host.now() - this.energyAt < 150;
  }
  get unresolved() {
    return (
      this.speaking ||
      !!this.current?.items.some(
        (item) => item.state !== "final" && item.state !== "failed",
      )
    );
  }
  get pending() {
    return !!this.current && !this.current.closed;
  }
  get unavailable() {
    return !!this.current?.items.some((item) => item.state === "failed");
  }
  item(id: string) {
    return this.items.get(id);
  }

  /** Meter activity schedules commits; only words can trigger interruption. */
  sample(rms: number) {
    if (this.disposed || !this.available) return;
    const now = this.host.now();
    const threshold = this.energySince === null ? 0.004 : 0.0025;
    if (rms >= threshold) {
      if (this.energySince === null) {
        this.energySince = now;
        this.detectedView = { ...this.host.view() };
      }
      this.energyAt = now;
      if (now - this.energySince >= 120) {
        this.supportedUntil = now + 2000;
        this.supportedSince = this.energySince;
      }
    } else if (now - this.energyAt >= 250) this.energySince = null;
    for (const item of this.items.values())
      if (item.state === "open" && !item.confirmed) this.confirm(item);
    this.tick();
  }

  delta(id: string, text: string, eventId?: string) {
    if (
      this.disposed ||
      !this.available ||
      !id ||
      !text ||
      (eventId && this.events.has(eventId))
    )
      return;
    if (eventId) {
      this.events.add(eventId);
      if (this.events.size > 2000)
        this.events.delete(this.events.values().next().value!);
    }
    let item = this.items.get(id);
    if (!item) {
      const now = this.host.now();
      item = {
        id,
        text: "",
        final: null,
        state: "open",
        startedAt: now,
        endedAt: now,
        committedAt: null,
        confirmed: false,
        utteranceId: null,
        version: 0,
        view: { ...(this.detectedView ?? this.host.view()) },
      };
      this.items.set(id, item);
      if (this.items.size > 300) {
        const old = [...this.items.values()].find(
          (i) =>
            i !== item &&
            (i.state === "final" || i.state === "failed") &&
            !this.current?.items.includes(i),
        );
        if (old) this.items.delete(old.id);
      }
    }
    if (item.state === "final" || item.state === "failed") return;
    item.text = (item.text + text).slice(0, 16000);
    item.endedAt = this.host.now();
    if (item.state === "open") this.confirm(item);
    if (item.confirmed) this.host.draft(item);
    this.changed();
  }

  private confirm(item: InputItem) {
    if (
      item.confirmed ||
      !hasSpokenWords(item.text) ||
      this.host.now() > this.supportedUntil ||
      item.endedAt < this.supportedSince
    )
      return;
    const now = this.host.now();
    if (
      !this.current ||
      this.current.closed ||
      this.unavailable ||
      now - this.current.items.at(-1)!.endedAt >= UTTERANCE_MERGE_MS
    ) {
      this.current = {
        id: `utterance_${this.counter + 1}`,
        version: 0,
        items: [],
        finalAt: 0,
        closed: false,
        repairOffered: false,
      };
    }
    item.view = { ...(this.detectedView ?? item.view) };
    item.confirmed = true;
    item.utteranceId = this.current.id;
    item.version = ++this.counter;
    this.current.version = item.version;
    this.current.items.push(item);
    this.current.finalAt = 0;
    this.host.log("input.wordsConfirmed", {
      itemId: item.id,
      utteranceId: item.utteranceId,
      userTurn: item.version,
      sinceDetectionMs: now - item.startedAt,
    });
    this.host.interrupt(item);
    this.changed();
  }

  committed(id: string) {
    const item = this.items.get(id);
    if (!item || item.state === "final" || item.state === "failed") return;
    item.state = "committed";
    item.committedAt ??= this.host.now();
    this.changed();
  }

  completed(id: string, text: string, error?: Record<string, unknown>) {
    const item = this.items.get(id);
    if (!item) return; // An unsolicited final never authorizes work.
    if (item.state === "final") return;
    const late = item.state === "failed";
    item.final = hasSpokenWords(text) ? text.trim() : "";
    if (!late) item.state = item.final && item.confirmed ? "final" : "failed";
    if (item.state === "final") this.repairOfferedSinceSuccess = false;
    if (this.current?.items.includes(item))
      this.current.finalAt = this.host.now();
    this.host.final(item, late);
    if (
      this.current &&
      (this.current.items.length > 20 ||
        this.current.items.reduce(
          (n, value) => n + (value.final ?? value.text).length + 1,
          0,
        ) > 8000)
    ) {
      this.fail(item, false);
      if (!this.repairOfferedSinceSuccess) {
        this.repairOfferedSinceSuccess = true;
        this.host.repair(
          "That request is too long for one handoff. Please split it into smaller requests; no work was started.",
        );
      }
    }
    if (!late && item.confirmed && (!item.final || error)) this.fail(item);
    this.changed();
  }

  private fail(item: InputItem, ask = true) {
    item.state = "failed";
    if (this.current?.items.includes(item) && !this.current.repairOffered) {
      this.current.repairOffered = true;
      if (ask && !this.repairOfferedSinceSuccess) {
        this.repairOfferedSinceSuccess = true;
        this.host.repair(
          "Part of that request could not be transcribed. Please repeat the full request; I have not started its work.",
        );
      }
    }
  }

  snapshot(): UtteranceSnapshot | null {
    const current = this.current;
    if (
      !this.available ||
      !current ||
      current.items.some((item) => item.state !== "final" || !item.final) ||
      this.speaking
    )
      return null;
    const items = current.items.map((item) => ({
      itemId: item.id,
      text: item.final!,
    }));
    // Never silently truncate material speech at the bridge boundary.
    if (
      items.length > 20 ||
      items.reduce((n, item) => n + item.text.length + 1, 0) > 8000
    )
      return null;
    return {
      id: current.id,
      version: current.version,
      items,
      text: items.map((item) => item.text).join(" "),
      view: { ...current.items[0].view },
      finalAt: current.finalAt,
    };
  }
  takeResponse(): boolean {
    if (!this.pending || !this.snapshot() || this.requested === this.version)
      return false;
    this.requested = this.version;
    return true;
  }
  answered(version: number) {
    if (this.current?.version === version) this.current.closed = true;
    this.changed();
  }
  waitFor(version: number, effect: boolean): Promise<UtteranceSnapshot | null> {
    return new Promise((resolve) => {
      this.waiters.add({ version, effect, resolve });
      this.flush();
    });
  }
  private flush() {
    for (const waiter of this.waiters) {
      if (
        this.disposed ||
        !this.available ||
        waiter.version !== this.version ||
        this.unavailable
      ) {
        this.waiters.delete(waiter);
        waiter.resolve(null);
        continue;
      }
      const value = this.snapshot();
      if (
        value &&
        (!waiter.effect ||
          this.host.now() - Math.max(value.finalAt, this.energyAt) >=
            EFFECT_QUIET_MS)
      ) {
        this.waiters.delete(waiter);
        waiter.resolve(value);
      }
    }
  }
  private changed() {
    this.flush();
    this.host.changed();
  }
  tick() {
    if (this.disposed || !this.available) return;
    const now = this.host.now();
    for (const item of this.items.values()) {
      if (
        item.state === "open" &&
        item.confirmed &&
        !this.speaking &&
        now - Math.max(this.energyAt, item.endedAt) >= INPUT_QUIET_MS
      ) {
        item.state = "committing";
        item.committedAt = now;
        if (
          !this.host.send({
            type: "input_audio_buffer.commit",
            event_id: `commit_${item.id}`,
          })
        ) {
          this.fail(item);
          continue;
        }
        this.host.log("input.commitRequested", {
          itemId: item.id,
          utteranceId: item.utteranceId,
          userTurn: item.version,
        });
      }
      if (
        (item.state === "committing" || item.state === "committed") &&
        item.committedAt !== null &&
        now - item.committedAt >= FINAL_TRANSCRIPT_MS
      ) {
        this.fail(item);
        this.host.final(item, false);
        this.host.log("transcription.result", {
          itemId: item.id,
          outcome: "timeout",
        });
      }
    }
    this.changed();
  }
  /** A lost microphone or connection invalidates unsent work; reconnect cannot replay it. */
  setAvailable(value: boolean) {
    if (this.available === value) return;
    this.available = value;
    if (!value) {
      for (const item of this.current?.items ?? [])
        if (item.state !== "failed") item.state = "failed";
      if (this.current) this.current.closed = true;
      this.energySince = null;
      this.supportedUntil = -Infinity;
      this.detectedView = null;
    }
    this.changed();
  }
  dispose() {
    this.disposed = true;
    this.flush();
  }
}
