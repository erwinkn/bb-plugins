import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Plan } from "../contract";
import plugin from "../server";

/** Preview-only transport. No BB instance or provider receives these messages. */
const messages: unknown[] = [];
const timers = new Set<ReturnType<typeof setTimeout>>();
type AgentInput = Pick<Parameters<BbPluginApi["sdk"]["threads"]["send"]>[0], "threadId" | "input">;
const queued = new Map<string, ReturnType<typeof makeQueueEntry>>();
let working = 0;
let agentWork = Promise.resolve();
let disposed = false;
const appliedPassages = new Map<string, string>();
const { bb, harness } = createFakePluginHost({
  pluginId: "plans",
  sdk: {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId !== "preview-thread-1") throw new Error("Preview thread not found. Use preview-thread-1.");
        return makeThreadResponse({ id: threadId, projectId: "preview-project", title: "Plan review preview" });
      },
      send: async (input: AgentInput & { mode?: string }) => {
        if (working > 0 && input.mode !== "steer-if-active") {
          const row = makeQueueEntry({ id: crypto.randomUUID(), threadId: input.threadId, content: input.input, updatedAt: Date.now() });
          queued.set(row.id, row);
          return { delivery: "queued", queuedMessage: row };
        }
        startWork(input);
        return { delivery: "sent" };
      },
      queuedMessages: {
        list: async () => [...queued.values()],
        update: async ({ queuedMessageId, input }: { queuedMessageId: string; input: AgentInput["input"] }) => {
          const previous = queued.get(queuedMessageId);
          if (!previous) throw new Error("Preview queued message no longer exists");
          const row = { ...previous, content: input, updatedAt: Date.now() };
          queued.set(queuedMessageId, row);
          return row;
        },
        delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
          queued.delete(queuedMessageId);
          return { ok: true };
        },
      },
    },
    projects: { get: async () => ({ id: "preview-project", name: "Demo workspace" }) },
  },
});
plugin(bb);

function startWork(input: AgentInput) {
  messages.push(input);
  working += 1;
  const timer = setTimeout(() => {
    timers.delete(timer);
    agentWork = agentWork.then(() => disposed ? undefined : simulateAgent(input)).catch((error) => {
      messages.push({ error: String(error) });
    }).finally(async () => {
      working -= 1;
      if (disposed || working > 0) return;
      for (const row of queued.values()) {
        queued.delete(row.id);
        await harness.behavior.emitThreadEvent("message.dispatched", { entry: row });
        if (disposed) return;
        startWork({ threadId: row.threadId, input: row.content as AgentInput["input"] });
      }
    });
  }, 1_500);
  timers.add(timer);
}

async function callTool(name: string, input: unknown, threadId: string) {
  const tool = harness.registrations.agentTools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing preview tool: ${name}`);
  const parsed = tool.parse(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return tool.execute(parsed.value, { threadId, projectId: "preview-project", signal: new AbortController().signal });
}

export async function simulateAgent(input: { threadId: string; input: Array<{ type: string; text?: string }> }) {
  const text = input.input.map((part) => part.text ?? "").join("\n");
  const planId = text.match(/\(plan ([^,]+), v\d+\)/)?.[1];
  if (!planId) return;
  for (const match of text.matchAll(/^(?:#(\d+) (ask|comment|redline)\b|edited #(\d+)\b)/gm)) {
    const plan = await handleRpc("get", { id: planId }) as Plan;
    const annotation = plan.comments.find((item) => item.number === Number(match[1] ?? match[3]));
    const correction = !!match[3];
    if (!annotation || annotation.state === "withdrawn" || (!correction && annotation.state !== "open") || plan.status === "approved") continue;
    const body = text.slice(match.index).split("\n\n")[0]!.split("\n").slice(2).join("\n");
    if (annotation.kind === "ask") {
      await callTool("plans_reply", { planId, annotation: `#${annotation.number}`, body: correction
        ? `Updated answer: ${body}` : "This keeps the change small and lets us verify it before the next step." }, input.threadId);
    } else {
      const markdown = plan.versions.at(-1)!.markdown;
      const passage = appliedPassages.get(annotation.id) ?? annotation.quote;
      const start = markdown.indexOf(passage);
      if (start < 0 || markdown.indexOf(passage, start + 1) >= 0) continue;
      const replacement = annotation.kind === "redline" ? "" : `${annotation.quote} (updated: ${body})`;
      await callTool("plans_update", { planId,
        markdown: markdown.slice(0, start) + replacement + markdown.slice(start + passage.length),
        summary: `Applied #${annotation.number}`, resolves: [`#${annotation.number}`] }, input.threadId);
      appliedPassages.set(annotation.id, replacement);
    }
  }
  for (const match of text.matchAll(/^reply on #(\d+)\b/gm)) {
    const plan = await handleRpc("get", { id: planId }) as Plan;
    if (plan.status === "approved") continue;
    await callTool("plans_reply", { planId, annotation: `#${match[1]}`, body: "Thanks, I will use this in the next change.", resolve: false }, input.threadId);
  }
  const plan = await handleRpc("get", { id: planId }) as Plan;
  if (plan.status === "open") await callTool("plans_handoff", { planId }, input.threadId);
}

export async function handleRpc(method: string, input: unknown): Promise<unknown> {
  return harness.behavior.callRpc(method, input);
}
export function getPreviewMessages() { return messages; }
export function getPreviewEvents(after: number) {
  const signals = harness.inspection.realtimeSignals;
  return { signals: signals.slice(after), cursor: signals.length, working: working > 0, pending: harness.inspection.pendingInteractions.length > 0 };
}
export async function disposePreview() {
  disposed = true;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  queued.clear();
  await agentWork;
  await harness.lifecycle.dispose();
}
