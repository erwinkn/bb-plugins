export interface OutputItem {
  outputIndex: number;
  itemId: string;
  type: string;
}

export interface HeldCall {
  event: Record<string, unknown>;
  outputIndex: number;
  state: "held" | "running" | "finished";
}

interface ResponseOutput {
  items: OutputItem[];
  calls: HeldCall[];
  generationDone: boolean;
  hasAudio: boolean;
  audioStarted: boolean;
  drained: boolean;
  interrupted: boolean;
  failed: boolean;
  violationLogged: boolean;
}

/** Pure response ledger. The caller owns transport, execution and logging. */
export class OutputSequencer {
  private responses = new Map<string, ResponseOutput>();

  created(id: string) {
    if (this.responses.has(id)) return;
    this.responses.set(id, {
      items: [], calls: [], generationDone: false, hasAudio: false,
      audioStarted: false, drained: false, interrupted: false, failed: false,
      violationLogged: false,
    });
  }

  item(id: string, item: OutputItem): boolean {
    const response = this.responses.get(id);
    if (!response) return false;
    const index = response.items.findIndex(existing => existing.outputIndex === item.outputIndex);
    if (index < 0) response.items.push(item);
    else response.items[index] = item;
    response.items.sort((a, b) => a.outputIndex - b.outputIndex);
    const violation = response.items.some(message => message.type === "message" &&
      response.items.some(call => call.type === "function_call" && call.outputIndex < message.outputIndex));
    if (!violation || response.violationLogged) return false;
    response.violationLogged = true;
    return true;
  }

  done(id: string, output: unknown) {
    const response = this.responses.get(id);
    if (!response) return;
    response.generationDone = true;
    response.hasAudio = Array.isArray(output) && output.some(item =>
      item?.type === "message" && Array.isArray(item.content) &&
      item.content.some((part: { type?: string }) => part?.type === "audio" || part?.type === "output_audio"));
  }

  started(id: string) {
    const response = this.responses.get(id);
    if (response) response.audioStarted = true;
  }

  stopped(id: string) {
    const response = this.responses.get(id);
    if (response && !response.interrupted) response.drained = true;
  }

  interrupted(id: string): HeldCall[] {
    const response = this.responses.get(id);
    if (!response) return [];
    // A completed drain stays a drain, even if the user later cancels its tools.
    if (!response.drained) response.interrupted = true;
    return this.cancelHeld(response);
  }

  failed(id: string): HeldCall[] {
    const response = this.responses.get(id);
    if (!response) return [];
    response.failed = true;
    return this.cancelHeld(response);
  }

  private cancelHeld(response: ResponseOutput) {
    const calls = response.calls.filter(call => call.state === "held");
    calls.sort((a, b) => a.outputIndex - b.outputIndex);
    for (const call of calls) call.state = "finished";
    return calls;
  }

  hold(id: string, event: Record<string, unknown>): boolean {
    const response = this.responses.get(id);
    if (!response || response.interrupted || response.failed || this.hasCall(id, event.call_id)) return false;
    const item = response.items.find(item => item.itemId === event.item_id);
    response.calls.push({ event, state: "held", outputIndex:
      typeof event.output_index === "number" ? event.output_index : item?.outputIndex ?? response.calls.length });
    return true;
  }

  hasCall(id: string, callId: unknown) {
    return this.responses.get(id)?.calls.some(call => call.event.call_id === callId) ?? false;
  }

  /** Claim one call at a time, so interruption can still cancel the rest. */
  next(): HeldCall | undefined {
    if ([...this.responses.values()].some(response => response.calls.some(call => call.state === "running"))) return;
    for (const response of this.responses.values()) {
      if (response.interrupted || response.failed || !response.generationDone ||
          !(response.drained || (!response.hasAudio && !response.audioStarted))) continue;
      const call = response.calls.filter(call => call.state === "held")
        .sort((a, b) => a.outputIndex - b.outputIndex)[0];
      if (call) { call.state = "running"; return call; }
    }
  }

  finished(call: HeldCall) { call.state = "finished"; }

  get pendingCalls() {
    let count = 0;
    for (const response of this.responses.values()) {
      count += response.calls.filter(call => call.state !== "finished").length;
    }
    return count;
  }

  get playbackPending() {
    return [...this.responses.values()].some(response =>
      response.audioStarted && !response.drained && !response.interrupted);
  }

  unsettledResponseIds() {
    return [...this.responses].filter(([, response]) =>
      response.calls.some(call => call.state !== "finished") ||
      (!response.drained && !response.interrupted &&
        (!response.generationDone || response.audioStarted || response.hasAudio))).map(([id]) => id);
  }

  state(id: string) { return this.responses.get(id); }

  settled(id: string) {
    const response = this.responses.get(id);
    return !!response && response.generationDone &&
      (response.drained || response.interrupted || (!response.hasAudio && !response.audioStarted)) &&
      response.calls.every(call => call.state === "finished");
  }

  reset() { this.responses.clear(); }
}
