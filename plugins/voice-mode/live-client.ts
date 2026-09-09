import { liveToolArgs, LIVE_EFFECTS, type LiveTool } from "./live-tools.ts";
import type { InputController } from "./input-controller.ts";
import { UiActionSchema } from "./ui-actions.ts";
import { nativeUi } from "./native-ui.ts";

export type ToolUtterance = { id: string; version: number; text: string; startedAt: number };
export type ResponseBinding = { origin: "user" | "background"; utterance: ToolUtterance | null };
export type LiveToolInput = ResponseBinding & { nonce: string; conversationId: string; tool: LiveTool; args: Record<string, unknown>; occurrence: number };
export type ClientRpc = (method: string, input: unknown) => Promise<unknown>;
export const continuedSpeaking = "Not executed: the user continued speaking.";

export function canonicalArgs(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalArgs).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => `${JSON.stringify(key)}:${canonicalArgs(val)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** One call's immutable tool bindings and occurrence numbers. */
export class LiveClient {
  private calls = new Map<string, LiveToolInput>();
  private occurrences = new Map<string, number>();
  constructor(private rpc: ClientRpc, private current: () => boolean, private input: Pick<InputController, "version" | "waitFor">,
    private nonce: string, private conversationId: string) {}

  async execute(callId: string, name: string, raw: unknown, binding: ResponseBinding): Promise<unknown> {
    if (!(name in liveToolArgs)) throw new Error(`Unknown realtime tool: ${name}`);
    const tool = name as LiveTool;
    const args = liveToolArgs[tool].parse(raw) as Record<string, unknown>;
    let call = this.calls.get(callId);
    if (!call) {
      const key = `${binding.utterance?.id}:${binding.utterance?.version}:${tool}:${canonicalArgs(args)}`;
      const occurrence = this.occurrences.get(key) ?? 0;
      this.occurrences.set(key, occurrence + 1);
      call = { ...binding, nonce: this.nonce, conversationId: this.conversationId, tool, args, occurrence };
      this.calls.set(callId, call);
    }
    if (LIVE_EFFECTS.has(tool) && call.origin === "user") {
      if (!call.utterance) return { status: "failed", error: "Not authorized: an effect needs a complete user utterance" };
      const delay = tool !== "prepare_draft" && tool !== "control_ui";
      const snapshot = await this.input.waitFor(call.utterance.version, delay);
      if (!snapshot || !this.current() || snapshot.id !== call.utterance.id) return continuedSpeaking;
    }
    if (!this.current()) return { status: "cancelled", error: "The voice call ended" };
    const { origin, ...rest } = call;
    const payload = { ...rest, responseOrigin: origin };
    if (tool !== "prepare_draft" && tool !== "control_ui") return this.rpc("runTool", payload);
    const begun = await this.rpc("beginClientEffect", payload) as { execute: boolean; operationId?: string; receipt: unknown; action?: unknown };
    if (!begun.execute) return begun.receipt;
    if (!begun.operationId) throw new Error("The client effect has no operation identity");
    const isCurrent = () => this.current() && origin === "user" && !!call.utterance && this.input.version === call.utterance.version;
    let result: { status: "succeeded" | "failed" | "cancelled" | "unknown"; detail: string };
    if (!isCurrent()) result = { status: "cancelled", detail: "Not authorized: this response cannot change the UI" };
    else {
      try { result = await nativeUi.execute(UiActionSchema.parse(begun.action), isCurrent); }
      catch (error) { result = { status: "failed", detail: String(error) }; }
    }
    // The server also checks ownership. Never apply an accepted operation twice.
    if (!this.current()) return result;
    return this.rpc("finishClientEffect", { nonce: this.nonce, operationId: begun.operationId, status: result.status, result });
  }
}
