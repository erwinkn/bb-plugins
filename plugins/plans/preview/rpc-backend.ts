import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

/** Preview-only transport. No BB instance or provider receives these messages. */
const messages: unknown[] = [];
const { bb, harness } = createFakePluginHost({
  pluginId: "plans",
  sdk: {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        if (threadId !== "preview-thread-1") throw new Error("Preview thread not found. Use preview-thread-1.");
        return makeThreadResponse({ id: threadId, projectId: "preview-project", title: "Plan review preview" });
      },
      send: async (input: unknown) => { messages.push(input); return { ok: true }; },
    },
    projects: { get: async () => ({ id: "preview-project", name: "Demo workspace" }) },
  },
});
plugin(bb);

export async function handleRpc(method: string, input: unknown): Promise<unknown> {
  return harness.behavior.callRpc(method, input);
}
export function getPreviewMessages() { return messages; }
export async function disposePreview() { await harness.lifecycle.dispose(); }
